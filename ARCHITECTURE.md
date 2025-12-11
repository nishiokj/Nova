# Clean Architecture Refactoring

## Overview

This refactoring establishes a clean, modular architecture with proper separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                         │
│  run_single.py              run_multi.py                     │
│  (single-process)           (multi-process)                  │
│  └─ app/single_process_app  └─ app/multi_process_app        │
│     Orchestrates services       Orchestrates processes       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   COMMUNICATION LAYER                        │
│  communication/event_bus.py                                  │
│  - EventBusProtocol (interface)                              │
│  - InMemoryEventBus (single-process)                         │
│  - MultiProcessEventBus (multi-process)                      │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      SERVICE LAYER                           │
│  services/                                                    │
│  - audio_service.py (pure VAD/audio processing)              │
│  - stt_service.py (pure STT transcription)                   │
│  - text_linter_service.py (pure text cleaning)               │
│                                                               │
│  ALL PURE FUNCTIONS - NO COUPLING                            │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      DOMAIN LAYER                            │
│  harness/ (unchanged)                                        │
│  - Agent, Router, Tools, ServiceRep                          │
└─────────────────────────────────────────────────────────────┘
```

## Key Changes

### 1. **Separate Entry Points** ✅
- **Old**: `main.py` with `if args.v2:` conditionals
- **New**:
  - `run_single.py` - Single-process runtime
  - `run_multi.py` - Multi-process runtime
  - No more "V2" suffix confusion

### 2. **Pure Service Layer** ✅
- **Old**: `SpeechTextBridge` coupled to `AgentHarness`
- **New**: Pure services with no domain knowledge
  - `AudioService`: VAD + speech detection (no harness coupling)
  - `STTService`: Transcription (no harness coupling)
  - `TextLinterService`: Text cleaning (no harness coupling)
  - Dependencies (logger, config) are **injected**

### 3. **Universal EventBus** ✅
- **Old**: V1 uses no bus, V2 uses `harness.EventBus`
- **New**: Universal communication layer
  - `EventBusProtocol`: Interface all buses implement
  - `InMemoryEventBus`: Fast threading.Queue for single-process
  - `MultiProcessEventBus`: multiprocessing.Queue for multi-process
  - Services use `EventBusProtocol` (runtime-agnostic)

### 4. **Unified Configuration** ✅
- **Old**: `AudioConfig`, `HarnessConfig` separate
- **New**: Single `AppConfig` with all configuration
  - `config/app_config.json` - single source of truth
  - Service configs, runtime config, logging config all in one place

### 5. **Dependency Injection** ✅
- **Old**: Services create their own loggers
- **New**: All dependencies injected
  - Loggers injected
  - Config injected
  - No more `logging.getLogger(__name__)` in services

### 6. **Application Orchestration** ✅
- **Old**: Tangled in `main.py`
- **New**: Clean orchestration layer
  - `app/base_app.py`: Common base class
  - `app/single_process_app.py`: Single-process orchestration
  - `app/multi_process_app.py`: Multi-process orchestration
  - Wire services via EventBus
  - Inject dependencies

## File Structure

```
jesus/
├── run_single.py           # NEW: Single-process entry point
├── run_multi.py            # NEW: Multi-process entry point
├── app_config.py           # NEW: Unified configuration
│
├── app/                    # NEW: Application layer
│   ├── __init__.py
│   ├── base_app.py         # Base application class
│   ├── single_process_app.py  # Single-process orchestration
│   └── multi_process_app.py   # Multi-process orchestration
│
├── services/               # NEW: Pure service layer
│   ├── __init__.py
│   ├── audio_service.py    # Pure audio processing
│   ├── stt_service.py      # Pure STT
│   └── text_linter_service.py  # Pure text linting
│
├── communication/          # NEW: Communication layer
│   ├── __init__.py
│   ├── events.py           # Event definitions
│   ├── event_bus_protocol.py  # EventBus interface
│   ├── in_memory_bus.py    # Single-process EventBus
│   └── multiprocess_bus.py # Multi-process EventBus
│
├── harness/                # UNCHANGED: Domain layer
│   ├── agent.py
│   ├── router.py
│   ├── tools.py
│   ├── event_bus.py        # Still used by multiprocess
│   └── ...
│
├── config/
│   ├── app_config.json     # NEW: Unified application config
│   └── harness_config.json # Existing harness config
│
└── main.py                 # OLD: Will be deprecated
```

## Migration Guide

### For Users

**Option 1: Single-Process (Development/Testing)**
```bash
# Use new entry point
python run_single.py

# Or with custom config
python run_single.py --config my_config.json
```

**Option 2: Multi-Process (Production)**
```bash
# Use new entry point
python run_multi.py

# Or with custom config
python run_multi.py --config my_config.json
```

**Create Default Config**
```bash
python run_single.py --create-config
# or
python run_multi.py --create-config
```

**List Audio Devices**
```bash
python run_single.py --list-devices
# or
python run_multi.py --list-devices
```

### For Developers

**Old Way (Coupled)**
```python
# Services knew about harness
class SpeechTextBridge:
    def __init__(self, harness: AgentHarness):
        self.harness = harness  # COUPLING
        self.logger = logging.getLogger(__name__)  # NOT INJECTED
```

**New Way (Clean)**
```python
# Services are pure
class STTService:
    def __init__(self, config: STTConfig, logger: Logger):
        self.config = config  # INJECTED
        self.logger = logger  # INJECTED
        # No knowledge of harness, EventBus, or application
```

**Old Way (No EventBus)**
```python
# Direct function calls
transcript = stt.transcribe(audio)
response = harness.process(transcript)
tts.speak(response)
```

**New Way (EventBus)**
```python
# Publish/subscribe via EventBus
event_bus.publish(AudioCapturedEvent(...))
# STT subscribes, processes, publishes TranscriptionCompleteEvent
# Harness subscribes, processes, publishes AgentResponseCompleteEvent
# TTS subscribes, speaks
```

## Benefits

### 1. **Separation of Concerns**
- Services don't know about application
- Application doesn't know about service internals
- Clear boundaries

### 2. **Runtime Agnostic**
- Services work identically in single or multi-process
- Just swap EventBus implementation
- No service code changes needed

### 3. **Testable**
- Services are pure functions
- Easy to unit test (inject mock logger, config)
- No complex mocking of harness

### 4. **Configuration Unified**
- One config file for entire app
- Easy to understand and modify
- Version controllable

### 5. **Dependency Injection**
- Logger, config, EventBus injected
- No hidden dependencies
- Clear dependency graph

### 6. **No More "V2" Confusion**
- Two first-class entry points
- No versioning in names
- Clear choice: single vs multi

## Backward Compatibility

### Deprecated (but still works)
- `main.py` - Still functional, but deprecated
- `audio.py:SpeechTextBridge` - Replaced by clean service orchestration
- Direct harness coupling - Now via EventBus

### Migration Path
1. **Phase 1** (Now): New architecture available alongside old
2. **Phase 2** (Next): Mark old code as deprecated
3. **Phase 3** (Future): Remove old code

## Examples

### Single-Process Example
```bash
# Create config
python run_single.py --create-config

# List devices
python run_single.py --list-devices

# Run with default config
python run_single.py

# Run with custom config
python run_single.py --config config/my_app_config.json
```

### Multi-Process Example
```bash
# Create config
python run_multi.py --create-config

# Run
python run_multi.py
```

### Custom Configuration
```json
{
  "runtime": {
    "mode": "multi",
    "max_agent_pending": 1
  },
  "logging": {
    "level": "DEBUG",
    "log_dir": "logs"
  },
  "audio": {
    "sample_rate": 16000,
    "device_index": 0
  },
  "stt": {
    "engine": "whisper",
    "model_size": "tiny.en"
  },
  "harness": {
    "config_path": "config/harness_config.json",
    "default_tier": "advanced"
  }
}
```

## Testing

### Test Services Independently
```python
from services import STTService, STTConfig
import logging

# Create logger
logger = logging.getLogger("test")

# Create config
config = STTConfig(engine="whisper", model_size="tiny.en")

# Create service with injected dependencies
stt = STTService(config=config, logger=logger)

# Test (no harness, no EventBus needed)
stt.initialize()
result = stt.transcribe(audio_chunk)
assert result.text == "expected"
```

### Test EventBus
```python
from communication import InMemoryEventBus, AudioCapturedEvent

bus = InMemoryEventBus()

received = []
bus.subscribe(
    EventType.AUDIO_CAPTURED,
    lambda e: received.append(e)
)

bus.publish(AudioCapturedEvent(...))
assert len(received) == 1
```

## Performance

### Single-Process
- **Pros**: Simple, fast IPC (threading.Queue), easy to debug
- **Cons**: GIL-limited, all on one CPU core
- **Best for**: Development, testing, debugging

### Multi-Process
- **Pros**: True parallelism, no GIL, better throughput
- **Cons**: More complex, slower IPC (multiprocessing.Queue)
- **Best for**: Production, maximum performance

## Next Steps

1. ✅ **Phase 1 Complete**: Clean architecture implemented
2. **Phase 2**: Test with real workloads
3. **Phase 3**: Deprecate old code
4. **Phase 4**: Remove old code

## Questions?

See:
- `run_single.py --help`
- `run_multi.py --help`
- `config/app_config.json` - Example configuration
- This document - Architecture overview
