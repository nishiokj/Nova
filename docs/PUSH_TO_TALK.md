# Push-to-Talk Voice Mode

## Overview

The TUI now supports **Push-to-Talk (PTT)** voice input mode, allowing you to use voice commands alongside traditional text input. This mode uses your microphone to capture audio, transcribes it, and sends it to the agent - all through the same event bus architecture.

## Architecture

### Components

1. **PushToTalkAudioWorker** (`src/workers/ptt_audio_worker.py`)
   - Simplified audio worker for on-demand recording
   - Records audio while `recording_event` is set
   - Transcribes using Whisper (local, offline STT)
   - Publishes `TranscriptionCompleteEvent` to event bus

2. **TUI Voice Mode** (`tui/simple_tui.py`)
   - Toggle between text and voice modes
   - Detects SPACE key press/release for recording
   - Shows recording status in UI
   - Handles transcription events (existing code!)

3. **Event Flow**
   ```
   User presses SPACE
       ↓
   TUI sets recording_event
       ↓
   PTT Worker starts recording
       ↓
   User releases SPACE
       ↓
   TUI clears recording_event
       ↓
   PTT Worker stops & transcribes
       ↓
   TranscriptionCompleteEvent published
       ↓
   TUI receives event (existing handler)
       ↓
   Agent processes request
   ```

## Usage

### Enabling Voice Mode

1. Start the TUI:
   ```bash
   python run_tui.py
   ```

2. Type `/voice` to enable voice mode:
   ```
   > /voice
   ```

3. You'll see:
   ```
   Voice mode enabled.

   Press and hold SPACE to record your message.
   Release SPACE to send.
   ```

### Recording a Voice Message

1. **Press and HOLD** the SPACE bar
2. Speak your message
3. **Release** the SPACE bar
4. Wait for transcription (should appear in seconds)
5. Agent will process and respond

### Switching Modes

- **Voice → Text**: Type `/voice` again to toggle back
- **Still works in voice mode**: You can type text commands normally
  - Type `/quit` to exit
  - Type `/help` for commands
  - Type any text and press Enter to send as text

### Disabling Voice Mode

```
> /voice
Voice mode disabled. Text input enabled.
```

## Features

### Dual Input Support
- ✅ Voice input via SPACE key (PTT)
- ✅ Text input still works in voice mode
- ✅ Slash commands work in both modes
- ✅ Same event bus for both input types

### UI Indicators
- Header shows: `Mode: VOICE 🎤` when enabled
- Status shows: `🎤 Recording...` while holding SPACE
- Recording status clears after release

### Integration
- Uses existing `TranscriptionCompleteEvent` handling
- Works with all existing agent features
- No changes needed to agent/harness code

## Technical Details

### Audio Configuration

The PTT worker uses:
- **Sample Rate**: 16kHz (standard for speech recognition)
- **Channels**: Mono (1 channel)
- **Format**: 16-bit PCM
- **Transcription**: Whisper (faster-whisper with CPU inference)

### Device Selection

On startup, the worker automatically:
1. Detects available audio input devices
2. Selects first suitable microphone
3. Falls back gracefully if no device found

### Error Handling

- If audio device not available: Error message shown, mode disabled
- If transcription fails: Warning logged, no message sent
- If recording fails: Error logged, recording stopped

## Limitations

### Current Implementation

1. **SPACE Key Detection**: Uses raw terminal mode
   - Works well on Unix/Linux/macOS
   - May need adjustment for Windows

2. **Transcription Service**: Uses Whisper (faster-whisper)
   - Runs locally on CPU (no internet required)
   - First run will download model files (~150MB for base model)
   - Uses int8 quantization for faster inference
   - Can be configured to use different model sizes (tiny, base, small, medium, large)

3. **Recording Control**: Simple press/release
   - Not true "hold to record" detection
   - Works well enough for most use cases
   - Could be improved with better key state tracking

## Future Enhancements

### Potential Improvements

1. **Better Key Detection**
   - True press/release detection
   - Support other PTT keys (Ctrl, Alt, etc.)
   - Platform-specific implementations

2. **STT Performance**
   - GPU acceleration support (CUDA/Metal)
   - Switch to Whisper.cpp for even faster inference
   - Configurable model sizes per use case

3. **Audio Feedback**
   - Beep on recording start/stop
   - Visual recording indicator
   - Audio level meter

4. **Advanced Features**
   - Voice activation (continuous mode)
   - Multiple language support
   - Custom wake words

## Troubleshooting

### No Audio Device Found

**Error**: `Failed to start voice mode. Check audio device availability.`

**Solutions**:
1. Check microphone is connected
2. Verify permissions (macOS: System Preferences → Security & Privacy → Microphone)
3. Test with: `python -c "import pyaudio; pyaudio.PyAudio().get_device_count()"`

### Transcription Not Working

**Error**: Silence or `[Warning] Transcription failed`

**Solutions**:
1. Ensure Whisper model downloaded successfully (first run downloads ~150MB)
2. Speak louder/clearer
3. Check microphone input level in system settings
4. Try recording longer (minimum ~0.5 seconds)
5. Check logs for Whisper initialization errors

### Recording Doesn't Stop

**Issue**: Status stuck at "🎤 Recording..."

**Solutions**:
1. Press SPACE again to force stop
2. Press Ctrl+C to exit recording
3. Type `/voice` to disable and re-enable mode

## Testing

### Manual Testing Checklist

- [ ] Enable voice mode with `/voice`
- [ ] Press SPACE and see "🎤 Recording..." status
- [ ] Release SPACE and status clears
- [ ] Transcription appears in conversation
- [ ] Agent responds to voice input
- [ ] Text input still works in voice mode
- [ ] Slash commands work in voice mode
- [ ] Disable voice mode with `/voice`
- [ ] Mode indicator updates in header

### Integration Testing

```bash
# 1. Start TUI
python run_tui.py

# 2. Test text mode
> Hello
[Wait for response]

# 3. Enable voice mode
> /voice

# 4. Test PTT
[Press SPACE] "What is the capital of France?" [Release SPACE]
[Wait for transcription and response]

# 5. Test text in voice mode
> /status
[Verify output]

# 6. Disable voice mode
> /voice

# 7. Verify text mode still works
> Goodbye
[Wait for response]
```

## Code Changes Summary

### New Files
- `src/workers/ptt_audio_worker.py` - PTT audio worker implementation
- `docs/PUSH_TO_TALK.md` - This documentation

### Modified Files
- `tui/simple_tui.py` - Added voice mode toggle, PTT input handler, status display

### Key Methods Added
- `SimpleTUI._toggle_voice_mode()` - Toggle voice mode on/off
- `SimpleTUI._start_ptt_worker()` - Start PTT audio worker
- `SimpleTUI._stop_ptt_worker()` - Stop PTT audio worker
- `SimpleTUI._get_voice_input()` - Handle PTT input with SPACE key

### Configuration Changes
- None required! Uses existing audio configuration

## References

- Audio Pipeline: `src/audio_pipeline/audio_pipeline.py`
- Event System: `src/communication/events.py`
- TUI Implementation: `tui/simple_tui.py`
- App Configuration: `src/app_config.py`
