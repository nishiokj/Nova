# Voice Agent System

A production-ready multi-process voice agent system with STT, agent harness, TTS, and RL worker components.

## Features

- **Multi-Process Architecture**: Scalable design with separate processes for audio, agent, and TTS
- **Multiple STT Engines**: Whisper (local) and Google STT with GPU acceleration support
- **Agent Harness**: Tiered agent system (simple/standard/advanced) with tool execution
- **Custom Agents**: Bring your own agents via simple configuration
- **RL Worker**: Optional reinforcement learning log creation
- **Docker Support**: Production-ready containerization with CPU and GPU variants (using [uv](https://github.com/astral-sh/uv) for fast builds)
- **Evaluation Framework**: 50+ evals using LLM-as-a-judge

## Quick Start

### Docker (Recommended for Linux)

```bash
# 1. Clone and setup
git clone <repository-url>
cd voice-agent-system
cp .env.example .env
# Edit .env and add your API keys (OPENAI_API_KEY or ANTHROPIC_API_KEY)

# 2. Start with Docker Compose
docker-compose up voice-agent

# With GPU acceleration:
docker-compose --profile gpu up voice-agent-gpu
```

See [docs/docker_deployment.md](docs/docker_deployment.md) for platform-specific instructions (macOS, Windows).

### Native Installation (macOS, Linux, Windows)

```bash
# 1. Install system dependencies
# macOS:
brew install python@3.11 portaudio ffmpeg

# Linux:
sudo apt-get install python3.11 python3.11-venv portaudio19-dev ffmpeg espeak

# 2. Setup Python environment
./scripts/setup_env.sh
source .venv/bin/activate

# 3. Install package
pip install -e .

# 3a. Optional: add audio dependencies (PyAudio, TTS) if you plan to use a microphone
pip install -e ".[audio]"

# 4. Initialize configuration
voice-agent --init-config
# Edit ~/.config/voice-agent/.env and add API keys

# 5. Run
voice-agent
```

### Distribution via PyPI

```bash
pip install rex
# Optional: include audio dependencies for microphone + TTS hardware
pip install rex[audio]
```

`rex` installs the core runtime without OS-dependent audio packages, so headless environments avoid PortAudio/TTS headaches until you opt in.

See [docs/environment_setup.md](docs/environment_setup.md) for detailed platform instructions.

## Installation Options

| Method | Best For | Setup Time | Notes |
|--------|----------|------------|-------|
| **Docker** | Linux production/dev | 5 min | Best audio support on Linux |
| **Native** | macOS, Windows dev | 10 min | Direct hardware access |
| **pip install** | Distribution | 2 min | `pip install rex` installs the core runtime; add audio helpers with `pip install rex[audio]` when you need PyAudio/TTS |

## CLI Commands

```bash
# Version
voice-agent --version

# Initialize config (first-time setup)
voice-agent --init-config

# List audio devices
voice-agent --list-devices

# Validate configuration
voice-agent --validate-config

# Health check (for monitoring)
voice-agent --health-check

# Run with custom config
voice-agent --config /path/to/config.json

# Enable debug logging
voice-agent --debug

# Enable RL worker
voice-agent --rl
```

## Configuration

### Environment Variables

The system supports configuration via environment variables (Docker-friendly):

```bash
# API Keys (required)
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...

# STT Configuration
STT_MODEL=base.en              # Whisper model (tiny.en, base.en, small.en, etc.)
STT_DEVICE=auto                # Device (auto, cpu, cuda, mps)

# Audio Configuration
AUDIO_DEVICE_INDEX=0           # Specific microphone
AUDIO_SAMPLE_RATE=32000        # Sample rate in Hz

# Logging
LOG_LEVEL=INFO                 # DEBUG, INFO, WARNING, ERROR
LOG_DIR=logs
```

See [.env.example](.env.example) for full documentation.

### Config Files

- `config/app_config.json` - Application runtime and service configuration
- `config/harness_config.json` - Agent tier, tools, and LLM configuration

Config discovery follows XDG standard:
1. `~/.config/voice-agent/` (user config)
2. `./config/` (development)
3. Bundled templates (fallback)

## Custom Agents

Bring your own agents by implementing the simple agent protocol:

```python
class MyAgent:
    def __init__(self, llm_config, tool_registry):
        self.llm_config = llm_config
        self.tools = tool_registry

    def run(self, user_input: str, context=None):
        # Your implementation
        return AgentResponse(text="...", success=True)
```

Configure in `src/evals/configs/agent_config.json`:

```json
{
  "my_agent": {
    "type": "CustomAgent",
    "module": "my_agents.custom",
    "class": "MyAgent"
  }
}
```

See [docs/custom_agents.md](docs/custom_agents.md) for detailed guide.

## Architecture

```
┌─────────────┐
│ Main Process│  Audio Capture + STT (Whisper/Google)
└──────┬──────┘
       │ EventBus (IPC)
       ├───────────┐
       │           │
┌──────▼──────┐ ┌─▼────────┐
│ServiceRep   │ │TTS Worker│
│ Worker      │ │          │
│ (Agent +    │ │ (pyttsx3)│
│  Harness)   │ │          │
└─────────────┘ └──────────┘
       │
  ┌────▼─────┐
  │RL Worker │ (Optional)
  └──────────┘
```

- **Main**: Audio capture (PyAudio) → STT (faster-whisper) → Event publishing
- **ServiceRep**: Intent classification → Agent/Harness execution → Response
- **TTS**: Text-to-speech synthesis
- **RL Worker**: Episode logging for reinforcement learning

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run specific test file
pytest tests/test_agent.py

# Run with coverage
pytest --cov=src

# Lint and format
black src/ tests/
isort src/ tests/
ruff check src/ tests/

# Pre-commit hooks
pre-commit install
pre-commit run --all-files
```

## Evaluation

Run the evaluation framework:

```bash
# Run all evals
python scripts/run_eval.py

# Run specific categories
python scripts/run_eval.py --categories search code

# Use custom agent
python scripts/run_eval.py --agent-config my_agent

# Generate visualization
python scripts/run_eval.py --output results.json
```

## Docker Commands

```bash
# Build
docker build -t voice-agent:latest .

# Run with custom config
docker run -it --rm \
  --device /dev/snd:/dev/snd \
  -v $(pwd)/config:/config:ro \
  -v $(pwd)/logs:/app/logs \
  --env-file .env \
  voice-agent:latest

# Run headless (no audio devices required; reads text from stdin if interactive)
docker run -it --rm \
  -e VOICE_AGENT_HEADLESS=1 \
  -v $(pwd)/config:/config:ro \
  -v $(pwd)/logs:/app/logs \
  --env-file .env \
  voice-agent:latest voice-agent --config /config/app_config.json --headless

# Health check
docker run --rm --device /dev/snd:/dev/snd voice-agent:latest voice-agent --health-check

# Validate config
docker run --rm -v $(pwd)/config:/config:ro voice-agent:latest voice-agent --validate-config
```

## Documentation

- [Docker Deployment Guide](docs/docker_deployment.md) - Platform-specific Docker setup
- [Environment Setup](docs/environment_setup.md) - Native installation per OS
- [Custom Agents](docs/custom_agents.md) - Bring your own agents
- [Production Checklist](docs/production_checklist.md) - Deployment readiness

## Troubleshooting

**No audio devices found:**
```bash
# List devices
voice-agent --list-devices

# Check permissions (Linux)
sudo usermod -a -G audio $USER

# Docker: ensure device passthrough
docker run --device /dev/snd:/dev/snd ...

# Or run headless (no audio input required)
docker run -e VOICE_AGENT_HEADLESS=1 voice-agent:latest voice-agent --headless
```

**API key errors:**
```bash
# Verify keys loaded
env | grep API_KEY

# Or check validation
voice-agent --validate-config
```

**GPU not detected:**
```bash
# Check CUDA available
python -c "import torch; print(torch.cuda.is_available())"

# Force CPU
export STT_DEVICE=cpu
voice-agent
```

See [docs/docker_deployment.md#troubleshooting](docs/docker_deployment.md#troubleshooting) for more.

## License

UNLICENSED

## Contributing

See [Production Checklist](docs/production_checklist.md) for areas needing work.
