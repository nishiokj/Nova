# Audio Processor with VAD for Raspberry Pi

A modular audio processing system that uses Voice Activity Detection (VAD) to detect human speech and trigger child processes. Designed specifically for Raspberry Pi with Docker support.

## Features

- **Modular Audio Input**: Support for USB microphones, built-in audio, and other input devices
- **WebRTC VAD**: High-quality voice activity detection with configurable aggressiveness
- **64ms Chunks**: Optimized for real-time processing with 64ms audio chunks at 16kHz
- **Child Process Management**: Automatically start/stop processes when speech is detected
- **Docker Support**: Fully containerized for easy deployment
- **Configurable**: JSON configuration files for easy customization

## Quick Start

### Docker (Recommended)

1. **Build and run with docker-compose:**
```bash
docker-compose up --build
```

2. **Or build and run manually:**
```bash
docker build -t audio-processor .
docker run --device /dev/snd:/dev/snd --privileged audio-processor
```

### Native Python

1. **Install dependencies:**
```bash
pip install -r requirements.txt
```

2. **List available audio devices:**
```bash
python audio.py --list-devices
```

3. **Run with default settings:**
```bash
python audio.py
```

4. **Run with custom command:**
```bash
python audio.py --command "echo" "Speech detected!" --command "date"
```

## Configuration

### Command Line Options

- `--config`: Path to JSON configuration file
- `--list-devices`: List available audio input devices
- `--device-name`: Specify audio device by name (e.g., "USB")
- `--device-index`: Specify audio device by index number
- `--command`: Command to run on speech detection (can be used multiple times)

### Configuration File

Create `config/audio_config.json`:

```json
{
    "sample_rate": 16000,
    "chunk_duration_ms": 64,
    "channels": 1,
    "format": "pcm_16",
    "vad_aggressiveness": 2,
    "speech_timeout_ms": 1000,
    "silence_timeout_ms": 500,
    "device_index": null,
    "device_name": "USB"
}
```

### Parameters

- `sample_rate`: Audio sample rate (8000, 16000, 32000, or 48000 Hz)
- `chunk_duration_ms`: Audio chunk size in milliseconds (default: 64ms)
- `channels`: Number of audio channels (default: 1 for mono)
- `format`: Audio format ("pcm_16", "pcm_24", "pcm_32")
- `vad_aggressiveness`: VAD sensitivity (0-3, higher = more aggressive)
- `speech_timeout_ms`: Maximum speech duration before timeout
- `silence_timeout_ms`: Silence duration before ending speech detection
- `device_index`: Audio device index (use --list-devices to find)
- `device_name`: Audio device name substring (e.g., "USB", "Built-in")

## Usage Examples

### Basic Speech Detection
```bash
python audio.py --command "echo" "Hello, speech detected!"
```

### Multiple Commands
```bash
python audio.py \
  --command "echo" "Speech started" \
  --command "date" \
  --command "python" "my_script.py"
```

### USB Microphone
```bash
python audio.py --device-name "USB" --command "echo" "USB mic detected speech"
```

### With Configuration File
```bash
python audio.py --config config/audio_config.json --command "your_command"
```

## Docker Deployment

### Docker Compose (Recommended)

The `docker-compose.yml` file includes:
- Audio device access (`/dev/snd`)
- Privileged mode for audio hardware
- Volume mounts for configuration and logs
- Health checking

### Manual Docker Commands

**Build:**
```bash
docker build -t audio-processor .
```

**Run with audio device access:**
```bash
docker run -it --rm \
  --device /dev/snd:/dev/snd \
  --privileged \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/logs:/app/logs \
  audio-processor \
  python audio.py --config config/audio_config.json
```

## Raspberry Pi Specific Notes

### Audio Setup

1. **Enable audio:**
```bash
sudo raspi-config
# Go to Advanced Options > Audio > Force 3.5mm jack
```

2. **Install ALSA utilities:**
```bash
sudo apt-get update
sudo apt-get install alsa-utils
```

3. **Test audio input:**
```bash
arecord -l  # List recording devices
arecord -D plughw:1,0 -d 5 test.wav  # Test recording
```

### USB Microphone

1. **Check USB devices:**
```bash
lsusb
```

2. **Find audio device:**
```bash
cat /proc/asound/cards
```

3. **Set as default (optional):**
```bash
sudo nano /etc/asound.conf
# Add:
# pcm.!default {
#   type hw
#   card 1
# }
```

## Architecture

### Core Components

- **AudioInput**: Abstract base class for different audio sources
  - `PyAudioInput`: Default implementation using PyAudio
  - Extensible for other input types (ALSA, custom hardware)

- **VoiceActivityDetector**: WebRTC VAD wrapper with smoothing
  - Configurable aggressiveness levels
  - Buffer-based decision smoothing
  - Automatic chunk size handling

- **SpeechProcessor**: Main processing engine
  - Real-time audio chunk processing
  - Speech start/end detection
  - Callback-based event system

- **ChildProcessManager**: Process lifecycle management
  - Process registration and configuration
  - Automatic start/stop on speech events
  - Clean shutdown handling

- **AudioProcessor**: Main application class
  - Configuration management
  - Component coordination
  - CLI interface

### Audio Processing Flow

1. **Audio Capture**: Continuous capture of 64ms chunks at 16kHz
2. **VAD Processing**: Each chunk analyzed for speech content
3. **State Management**: Track speech start/end with timeout handling
4. **Event Triggering**: Fire callbacks on speech state changes
5. **Process Management**: Start/stop child processes as configured

## Troubleshooting

### Audio Issues

**No audio devices found:**
```bash
# Check ALSA devices
aplay -l
arecord -l

# Check permissions
sudo usermod -a -G audio $USER
```

**Permission denied:**
```bash
# Add user to audio group
sudo usermod -a -G audio $USER
# Logout and login again
```

**USB microphone not detected:**
```bash
# Check USB devices
lsusb

# Check kernel modules
lsmod | grep snd

# Reload audio modules
sudo modprobe snd-usb-audio
```

### Docker Issues

**Audio device not accessible:**
```bash
# Make sure audio group has correct permissions
ls -la /dev/snd/
# Run with privileged mode
docker run --privileged --device /dev/snd:/dev/snd ...
```

**Container can't access audio:**
```bash
# Check if audio works on host first
arecord -d 5 test.wav

# Run container interactively for debugging
docker run -it --device /dev/snd:/dev/snd audio-processor bash
```

## Performance Notes

- **CPU Usage**: WebRTC VAD is lightweight, typical usage <5% on Pi 4
- **Memory**: ~50MB Python + libraries, minimal audio buffering
- **Latency**: ~64ms processing delay + VAD computation (~1-2ms)
- **Audio Quality**: 16kHz mono provides good speech detection balance

## Extension Points

### Custom Audio Input
```python
class CustomAudioInput(AudioInput):
    def initialize(self, config: AudioConfig) -> bool:
        # Your custom initialization
        pass
    
    def read_chunk(self) -> Optional[bytes]:
        # Your custom audio reading
        pass
```

### Custom Processing
```python
processor = AudioProcessor()
processor.speech_processor.set_callbacks(
    on_speech_start=my_speech_handler,
    on_chunk_processed=my_chunk_handler
)
```

## License

MIT License - feel free to modify and distribute.