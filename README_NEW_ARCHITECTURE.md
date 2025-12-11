# Voice Agent System - Clean Architecture

## Quick Start

### Option 1: Multi-Process (Recommended for Production)

```bash
# Create default configuration
python run_multi.py --create-config

# List available audio devices
python run_multi.py --list-devices

# Run the system
python run_multi.py
```

### Option 2: Single-Process (Good for Development)

```bash
# Create default configuration
python run_single.py --create-config

# Run the system
python run_single.py
```

## What's New?

This is a **complete architectural refactoring** that provides:

- ✅ **Clean Separation**: Services don't know about application logic
- ✅ **Two Entry Points**: `run_single.py` and `run_multi.py` (no more "V2" confusion)
- ✅ **Unified Config**: Single `config/app_config.json` for everything
- ✅ **Dependency Injection**: Logger and config injected everywhere
- ✅ **EventBus Communication**: Universal pub/sub model for all runtimes
- ✅ **Pure Services**: Easy to test in isolation

## Architecture

```
┌─────────────────────────────────────────┐
│   run_single.py   │   run_multi.py     │  Entry Points
└─────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────┐
│   InMemoryEventBus │ MultiProcessBus   │  Communication
└─────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────┐
│   AudioService  │  STTService  │        │  Services
│   TextLinterService             │       │  (Pure Functions)
└─────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────┐
│   Harness (Agent, Router, Tools)        │  Domain
└─────────────────────────────────────────┘
```

## Configuration

Edit `config/app_config.json`:

```json
{
  "runtime": {
    "mode": "multi",
    "max_agent_pending": 1
  },
  "logging": {
    "level": "INFO",
    "log_dir": "logs"
  },
  "audio": {
    "sample_rate": 32000,
    "device_index": null
  },
  "stt": {
    "engine": "whisper",
    "model_size": "base.en"
  },
  "harness": {
    "config_path": "config/harness_config.json",
    "default_tier": "standard"
  }
}
```

## Single-Process vs Multi-Process

### Single-Process (`run_single.py`)

**When to Use:**
- Development and debugging
- Running on limited hardware
- Need simple stack traces

**Characteristics:**
- All components in threads
- Fast IPC (threading.Queue)
- Limited by Python GIL
- Easier to debug

**Performance:**
- Good for: Prototyping, testing
- Limited by: Single CPU core

### Multi-Process (`run_multi.py`)

**When to Use:**
- Production deployments
- Maximum performance needed
- Multi-core CPU available

**Characteristics:**
- Separate processes for Agent + TTS
- True parallelism (no GIL)
- IPC via multiprocessing.Queue
- Auto-restart on worker failure

**Performance:**
- Good for: Production, high throughput
- Limited by: IPC overhead (minimal)

## Usage Examples

### Basic Usage

```bash
# Multi-process (default)
python run_multi.py

# Single-process
python run_single.py
```

### With Custom Config

```bash
python run_multi.py --config path/to/my_config.json
```

### List Audio Devices

```bash
python run_multi.py --list-devices
```

### Get Help

```bash
python run_multi.py --help
python run_single.py --help
```

## Services

All services are **pure functions** with no coupling:

### AudioService
- Voice Activity Detection (VAD)
- Speech segment detection
- Noise filtering
- No knowledge of Harness or EventBus

### STTService
- Whisper or Google STT
- Direct PCM-to-text
- No knowledge of Harness or EventBus

### TextLinterService
- Text cleaning and validation
- Filler word removal
- No knowledge of Harness or EventBus

## EventBus

Universal communication layer:

```python
# Publish events
event_bus.publish(AudioCapturedEvent(...))

# Subscribe to events
event_bus.subscribe(
    EventType.TRANSCRIPTION_COMPLETE,
    handler_function
)
```

## File Structure

```
jesus/
├── run_single.py           # NEW: Single-process entry
├── run_multi.py            # NEW: Multi-process entry
├── app_config.py           # NEW: Unified config
│
├── app/                    # NEW: Application layer
│   ├── base_app.py
│   ├── single_process_app.py
│   └── multi_process_app.py
│
├── services/               # NEW: Service layer
│   ├── audio_service.py
│   ├── stt_service.py
│   └── text_linter_service.py
│
├── communication/          # NEW: Communication layer
│   ├── events.py
│   ├── event_bus_protocol.py
│   ├── in_memory_bus.py
│   └── multiprocess_bus.py
│
├── harness/                # Unchanged
│   └── ...
│
├── config/
│   └── app_config.json     # NEW: Unified config
│
├── ARCHITECTURE.md         # Comprehensive guide
└── REFACTORING_SUMMARY.md  # Summary of changes
```

## Migration from Old `main.py`

The old `main.py` still works, but is **deprecated**.

**Old Way:**
```bash
python main.py              # V1 single-process
python main.py --v2         # V2 multi-process (confusing!)
```

**New Way:**
```bash
python run_single.py        # Clear: single-process
python run_multi.py         # Clear: multi-process
```

## Troubleshooting

### No Audio Device Found

```bash
# List available devices
python run_multi.py --list-devices

# Set device in config
{
  "audio": {
    "device_index": 0  # Use specific device
  }
}
```

### STT Not Working

Check STT engine is installed:

```bash
# For Whisper
pip install faster-whisper

# For Google
pip install SpeechRecognition
```

### Import Errors

Make sure you're in the project root:

```bash
cd /path/to/jesus
python run_multi.py
```

## Documentation

- **ARCHITECTURE.md** - Comprehensive architecture guide
- **REFACTORING_SUMMARY.md** - Summary of refactoring changes
- **config/app_config.json** - Example configuration
- **This file** - Quick start guide

## Performance

### Expected Latency (Multi-Process)

- Audio capture: ~30ms
- STT (Whisper base.en): ~50-150ms
- Agent processing: ~200-500ms (depends on tier)
- TTS: ~100-300ms

**Total**: ~400-1000ms end-to-end

### Expected Latency (Single-Process)

Similar to multi-process, but limited by GIL for concurrent operations.

## Contributing

Services are now easy to test:

```python
from services import STTService, STTConfig
import logging

# Create service with injected dependencies
stt = STTService(
    config=STTConfig(engine="whisper", model_size="tiny.en"),
    logger=logging.getLogger("test")
)

# Test independently
stt.initialize()
result = stt.transcribe(audio_chunk)
assert result.text == "expected"
```

## Support

- Check **ARCHITECTURE.md** for detailed architecture
- Check **REFACTORING_SUMMARY.md** for changes
- Run with `--help` for usage information
- Enable debug logging in `config/app_config.json`

## License

[Your License]

## Credits

Built with clean architecture principles:
- Separation of concerns
- Dependency injection
- Pure functions
- Event-driven communication
