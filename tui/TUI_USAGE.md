# Simple TUI Usage Guide

## Overview

The Simple TUI provides a lightweight, text-based interface to the voice agent system without requiring audio hardware. It integrates directly with the backend's event bus pattern for real-time interaction.

## Features

- **Text-based interaction** - No microphone or speakers required
- **Real-time status** - Shows when the agent is thinking/processing
- **Slash commands** - Quick access to configuration and settings
- **Event bus integration** - Seamlessly connects to backend workers
- **Compact mode** - Toggle verbose or minimal output

## Quick Start

### Launch the TUI

```bash
python3 run_tui.py
```

Or directly:

```bash
python3 -m tui.simple_tui
```

### Basic Usage

1. **Send a message** - Type your text and press Enter
2. **Wait for response** - The TUI shows "[Thinking...]" while processing
3. **View response** - Agent's response appears below your message

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help message with all commands |
| `/config` | Display current configuration |
| `/models` | View LLM models and API key status |
| `/compact` | Toggle compact output mode (less verbose) |
| `/status` | Show system status (requests sent, workers, etc.) |
| `/quit` | Exit the TUI |

## Configuration

The TUI uses the same configuration as the main application:
- `config/app_config.json` - Main configuration file
- `~/.config/voice-agent/.env` - API keys and environment overrides

### Setting API Keys

Edit `~/.config/voice-agent/.env`:

```bash
# OpenAI
OPENAI_API_KEY=sk-...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Google
GOOGLE_API_KEY=...
```

Use `/models` command in the TUI to check which keys are configured.

## Architecture

The Simple TUI:
1. Starts backend workers (ServiceRep + ConsoleTTS)
2. Subscribes to EventBus for responses
3. Publishes `TranscriptionCompleteEvent` for text input (bypassing audio/STT)
4. Receives `AgentResponseCompleteEvent` to display results
5. Uses `ConsoleTTSWorker` for text output instead of audio

## Examples

### Basic Conversation

```
> Hello, how are you?

[Thinking...]

────────────────────────────────────────────────────────────
Hello! I'm doing well, thank you for asking. I'm here to help
you with any questions or tasks you have. How can I assist you
today?

[Response time: 1240ms]
────────────────────────────────────────────────────────────
```

### Compact Mode

```
> /compact

[Compact mode: ON]

> What's 2+2?

[Thinking...]

2+2 equals 4.

> /compact

[Compact mode: OFF]
```

### Configuration Check

```
> /config

============================================================
  Current Configuration
============================================================

Runtime Mode:    multi
Log Level:       INFO
Log Directory:   logs

STT Engine:      whisper
STT Model:       base.en
STT Device:      auto

TTS Engine:      auto
TTS Voice:       Samantha
TTS Rate:        200 wpm

Harness Config:  config/harness_config.json

To modify: Edit config/app_config.json or use environment variables
============================================================
```

## Troubleshooting

### No API keys configured

```
> /models
```

Check which API keys are configured and follow instructions to add them.

### Worker startup issues

Check logs in `logs/` directory for detailed error messages.

### Import errors

Ensure you're running from the project root directory and dependencies are installed:

```bash
pip install -r requirements.txt
```

## Development

The TUI is designed to be simple and extensible:

- `simple_tui.py` - Main TUI implementation (~350 lines)
- Event bus integration via `communication` module
- Slash commands handled locally (no backend roundtrip)
- Status updates via mailbox subscriptions

To add new slash commands, modify `_handle_slash_command()` method.

## Differences from Main App

| Feature | Main App | Simple TUI |
|---------|----------|------------|
| Audio Input | Microphone | Text input |
| Audio Output | TTS (speech) | Console text |
| STT | Whisper | Bypassed |
| VAD | Yes | Not needed |
| Audio Calibration | Yes | Not needed |
| Event Bus | Yes | Yes (same) |
| Harness/Agent | Yes | Yes (same) |

The TUI provides the same agent intelligence with a simpler I/O model.
