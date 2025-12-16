# Docker Deployment Guide

This guide covers deploying the Voice Agent System using Docker for cross-platform development and production environments.

## Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Building Images](#building-images)
- [Platform-Specific Audio Setup](#platform-specific-audio-setup)
- [Configuration](#configuration)
- [Running Containers](#running-containers)
- [Health Checks](#health-checks)
- [Troubleshooting](#troubleshooting)
- [Production Deployment](#production-deployment)

---

## Quick Start

The fastest way to get started on **Linux**:

```bash
# 1. Copy environment file
cp .env.example .env
# Edit .env and add your API keys

# 2. Build and start (Linux with PulseAudio/ALSA)
docker-compose up voice-agent

# OR with GPU acceleration:
docker-compose --profile gpu up voice-agent-gpu
```

**Note:** The Docker build uses [uv](https://github.com/astral-sh/uv) for 2-3x faster dependency installation compared to pip.

For macOS and Windows, see [Platform-Specific Audio Setup](#platform-specific-audio-setup) below.

---

## Prerequisites

### Required Software

1. **Docker** (version 20.10+)
   - [Install Docker](https://docs.docker.com/get-docker/)

2. **Docker Compose** (version 2.0+)
   - Included with Docker Desktop
   - Linux: `sudo apt-get install docker-compose-plugin`

3. **Audio Devices**
   - Microphone (input) - **Required**
   - Speakers (output) - Required for TTS

### For GPU Support (Optional)

- NVIDIA GPU with CUDA support
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
- Docker with `nvidia-runtime` configured

### Verify Installation

```bash
# Check Docker
docker --version

# Check Docker Compose
docker compose version

# Check NVIDIA runtime (if using GPU)
docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
```

---

## Building Images

### CPU-Only Image (Default)

```bash
# Build from Dockerfile
docker build -t voice-agent:latest .

# Or use docker-compose
docker-compose build voice-agent
```

### GPU-Accelerated Image

```bash
# Build with docker-compose
docker-compose build voice-agent-gpu

# Or manually with same Dockerfile (CUDA detected at runtime)
docker build -t voice-agent:gpu .
```

### Build Options

**Build with cache:**
```bash
docker build --build-arg BUILDKIT_INLINE_CACHE=1 -t voice-agent:latest .
```

**Build without cache (clean build):**
```bash
docker build --no-cache -t voice-agent:latest .
```

---

## Platform-Specific Audio Setup

### Linux (Recommended for Docker)

Docker audio support is **best on Linux** with either ALSA or PulseAudio.

#### Option A: ALSA (Simpler)

```bash
# Grant user access to audio group
sudo usermod -a -G audio $USER
# Log out and back in for group changes to take effect

# Run with ALSA device passthrough
docker run -it --rm \
  --device /dev/snd:/dev/snd \
  -v $(pwd)/config:/config:ro \
  -v $(pwd)/logs:/app/logs \
  --env-file .env \
  voice-agent:latest
```

#### Option B: PulseAudio (More Flexible)

```bash
# Share PulseAudio socket with container
docker run -it --rm \
  --device /dev/snd:/dev/snd \
  -v /run/user/$(id -u)/pulse:/run/user/1000/pulse:ro \
  -e PULSE_SERVER=unix:/run/user/1000/pulse/native \
  -v $(pwd)/config:/config:ro \
  -v $(pwd)/logs:/app/logs \
  --env-file .env \
  voice-agent:latest
```

### macOS

Docker audio passthrough is **limited on macOS**. We recommend:

**Recommended: Native Installation**
```bash
# Use native installation instead of Docker
brew install python@3.11 portaudio ffmpeg
./scripts/setup_env.sh
source .venv/bin/activate
voice-agent
```

**Alternative: Docker with Limitations**

- Audio device passthrough does not work reliably
- Consider network-based audio streaming (advanced)
- Or use Docker for testing without audio:

```bash
# Testing without audio (health checks will fail)
docker run -it --rm \
  -v $(pwd)/config:/config:ro \
  --env-file .env \
  voice-agent:latest voice-agent --help
```

### Windows

#### WSL2 with PulseAudio (Recommended)

```bash
# Install PulseAudio in WSL2
sudo apt-get update
sudo apt-get install pulseaudio

# Start PulseAudio
pulseaudio --start

# Run container with PulseAudio socket
docker run -it --rm \
  -v /mnt/wslg/runtime-dir/pulse:/run/user/1000/pulse:ro \
  -e PULSE_SERVER=unix:/run/user/1000/pulse/native \
  -v $(pwd)/config:/config:ro \
  --env-file .env \
  voice-agent:latest
```

#### Native Windows (Alternative)

For best Windows experience, use native Python installation:
```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\activate
pip install -e .
voice-agent
```

---

## Configuration

### Environment Variables (.env)

```bash
# Copy template
cp .env.example .env

# Edit with your favorite editor
nano .env  # or vim, code, etc.
```

**Minimum Required:**
```bash
# At least one API key
OPENAI_API_KEY=sk-proj-...
# or
ANTHROPIC_API_KEY=sk-ant-...
```

**Common Overrides:**
```bash
LOG_LEVEL=DEBUG                # Enable debug logging
STT_MODEL=tiny.en              # Use faster model
STT_DEVICE=cpu                 # Force CPU (no GPU)
AUDIO_DEVICE_INDEX=1           # Use specific microphone
```

See [.env.example](../.env.example) for full documentation.

### Config Files (config/)

Mount the `config/` directory as read-only:

```bash
# Default configs
-v $(pwd)/config:/config:ro

# Custom config directory
-v /path/to/my/configs:/config:ro
```

**Override harness config:**
```bash
-e HARNESS_CONFIG_PATH=/config/my_harness_config.json
```

---

## Running Containers

### Using Docker Compose (Recommended)

**CPU variant:**
```bash
docker-compose up voice-agent
```

**GPU variant:**
```bash
docker-compose --profile gpu up voice-agent-gpu
```

**Detached mode (background):**
```bash
docker-compose up -d voice-agent
docker-compose logs -f  # View logs
```

**Stop:**
```bash
docker-compose down
```

### Using Docker Run

**Basic run:**
```bash
docker run -it --rm \
  --device /dev/snd:/dev/snd \
  -v $(pwd)/config:/config:ro \
  -v $(pwd)/logs:/app/logs \
  --env-file .env \
  voice-agent:latest
```

**With GPU:**
```bash
docker run -it --rm \
  --gpus all \
  --device /dev/snd:/dev/snd \
  -v $(pwd)/config:/config:ro \
  -v $(pwd)/logs:/app/logs \
  -e STT_DEVICE=cuda \
  --env-file .env \
  voice-agent:latest
```

**List audio devices:**
```bash
docker run --rm \
  --device /dev/snd:/dev/snd \
  voice-agent:latest \
  voice-agent --list-devices
```

**Validate config:**
```bash
docker run --rm \
  -v $(pwd)/config:/config:ro \
  --env-file .env \
  voice-agent:latest \
  voice-agent --validate-config
```

---

## Health Checks

The Docker image includes built-in health checks.

### Manual Health Check

```bash
docker run --rm \
  --device /dev/snd:/dev/snd \
  voice-agent:latest \
  voice-agent --health-check
```

**Expected output:**
```
PASS: Health check successful
```

**Failed output:**
```
FAIL: No audio devices found
```

### Automatic Health Checks

Docker Compose monitors health automatically:

```bash
docker-compose ps
# Shows health status: healthy, unhealthy, starting
```

**Health check details:**
- Interval: 30 seconds
- Timeout: 5 seconds
- Start period: 10 seconds (grace period)
- Retries: 3

---

## Troubleshooting

### No Audio Devices Found

**Symptoms:**
```
ERROR [INFO] No audio devices found!
ERROR   Ensure you passed through audio devices:
ERROR     Linux:   --device /dev/snd:/dev/snd
```

**Solutions:**

1. **Verify host audio devices exist:**
   ```bash
   ls -la /dev/snd
   aplay -l  # List playback devices
   arecord -l  # List capture devices
   ```

2. **Check user in audio group:**
   ```bash
   groups | grep audio
   # If not present:
   sudo usermod -a -G audio $USER
   # Log out and back in
   ```

3. **Verify Docker device passthrough:**
   ```bash
   docker run --rm --device /dev/snd:/dev/snd alpine ls -la /dev/snd
   # Should show audio devices
   ```

### Permission Denied

**Symptoms:**
```
PermissionError: [Errno 13] Permission denied: '/app/logs/app.log'
```

**Solutions:**

1. **Fix log directory ownership:**
   ```bash
   sudo chown -R 1000:1000 logs/
   # UID 1000 matches container user 'voiceagent'
   ```

2. **Or run container as root (not recommended):**
   ```bash
   docker run --user root ...
   ```

### API Key Not Found

**Symptoms:**
```
WARNING [environment.api_keys]: No API keys found in environment
```

**Solutions:**

1. **Verify .env file loaded:**
   ```bash
   docker run --env-file .env voice-agent:latest env | grep API_KEY
   ```

2. **Or pass directly:**
   ```bash
   docker run -e OPENAI_API_KEY=sk-proj-... voice-agent:latest
   ```

### GPU Not Detected

**Symptoms:**
```
ERROR [stt.device]: CUDA requested but not available
```

**Solutions:**

1. **Verify nvidia-runtime installed:**
   ```bash
   docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
   ```

2. **Check Docker daemon config (`/etc/docker/daemon.json`):**
   ```json
   {
     "runtimes": {
       "nvidia": {
         "path": "nvidia-container-runtime",
         "runtimeArgs": []
       }
     }
   }
   ```

3. **Restart Docker:**
   ```bash
   sudo systemctl restart docker
   ```

### Container Exits Immediately

**Check logs:**
```bash
docker-compose logs voice-agent

# Or for docker run:
docker logs <container-id>
```

**Common causes:**
- Missing API keys
- Invalid configuration
- Audio device not accessible

---

## Production Deployment

### Best Practices

1. **Use specific image tags:**
   ```bash
   docker build -t voice-agent:v0.1.0 .
   # Not: voice-agent:latest
   ```

2. **Resource limits:**
   ```yaml
   # docker-compose.yml
   deploy:
     resources:
       limits:
         cpus: '2.0'
         memory: 4G
       reservations:
         cpus: '1.0'
         memory: 2G
   ```

3. **Persistent volumes:**
   ```yaml
   volumes:
     - voice-agent-logs:/app/logs
     - whisper-models:/app/.cache/whisper
   ```

4. **Secret management:**
   ```bash
   # Use Docker secrets instead of .env
   docker secret create openai_key <(echo "sk-proj-...")
   ```

5. **Monitoring:**
   ```bash
   # Export logs to aggregation service
   docker run --log-driver=json-file voice-agent:latest
   ```

### Scaling Considerations

**Single container is sufficient** for most use cases:
- Multi-process architecture handles concurrency
- Whisper STT is the bottleneck (GPU helps)
- Each container supports ~1-2 concurrent users

**For higher scale:**
- Run multiple containers behind load balancer
- Use GPU variant for faster STT
- Consider distributed message queue (replace multiprocessing.Queue)

---

## Next Steps

- Review [custom_agents.md](./custom_agents.md) for bringing your own agents
- Check [production_checklist.md](./production_checklist.md) for deployment readiness
- See [environment_setup.md](./environment_setup.md) for native installation

---

## Support

For issues and questions:
- GitHub Issues: [github.com/your-org/voice-agent-system/issues](https://github.com)
- Documentation: [docs/](../docs/)
