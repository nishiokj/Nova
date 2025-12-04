#!/usr/bin/env python3
"""
Main Entry Point - Voice-Activated AI Agent System

This module integrates:
- Audio input processing (audio.py) with enhanced VAD
- Text-to-speech output (voice.py)
- Agentic harness with routing, tools, and LLM backends

Flow:
1. Audio VAD captures speech -> transcribes to text
2. Text is cleaned/linted and passed to AgentHarness
3. Router classifies task difficulty
4. ServiceRep acknowledges request via TTS
5. Agent processes with tools and LLM
6. ServiceRep speaks final response

Usage:
    python main.py [--config CONFIG_PATH] [--list-devices] [--router-enabled] [--no-tts]
"""

import os
import sys
import time
import signal
import logging
import argparse
import threading
from typing import Optional, Callable
from queue import Queue, Empty
from multiprocessing import Process, Queue as MPQueue

# Local imports
from audio import AudioConfig, AudioDeviceManager, MainProcessor, ChildProcessor
from voice import VoiceConfig, VoiceStreamer, create_voice_config

# Harness imports
from harness import (
    AgentHarness,
    HarnessConfig,
    RuntimeConfig,
    HarnessResponse,
    HarnessState,
    create_harness,
    load_or_create_config,
    StructuredLogger,
    get_logger,
    set_logger
)


class TextLinter:
    """
    Cleans and lints transcribed speech text before processing.
    Handles common speech-to-text artifacts and normalizes input.
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)

        # Filler words to remove
        self.filler_words = {
            'um', 'uh', 'ah', 'er', 'hmm', 'hm', 'like',
            'you know', 'i mean', 'so yeah', 'basically'
        }

        # Common STT errors and corrections
        self.corrections = {
            'gonna': 'going to',
            'wanna': 'want to',
            'gotta': 'got to',
            'kinda': 'kind of',
            'sorta': 'sort of',
            'lemme': 'let me',
            'gimme': 'give me',
        }

    def lint(self, text: str) -> str:
        """
        Clean and normalize transcribed text.

        Args:
            text: Raw transcribed text

        Returns:
            Cleaned text ready for processing
        """
        if not text:
            return ""

        # Convert to lowercase for processing
        cleaned = text.strip()

        # Remove repeated words (common STT artifact)
        words = cleaned.split()
        deduplicated = []
        for i, word in enumerate(words):
            if i == 0 or word.lower() != words[i-1].lower():
                deduplicated.append(word)
        cleaned = ' '.join(deduplicated)

        # Remove filler words (case insensitive)
        for filler in self.filler_words:
            import re
            pattern = r'\b' + filler + r'\b'
            cleaned = re.sub(pattern, '', cleaned, flags=re.IGNORECASE)

        # Apply corrections
        for wrong, right in self.corrections.items():
            import re
            pattern = r'\b' + wrong + r'\b'
            cleaned = re.sub(pattern, right, cleaned, flags=re.IGNORECASE)

        # Clean up extra whitespace
        cleaned = ' '.join(cleaned.split())

        # Ensure proper sentence ending
        if cleaned and not cleaned[-1] in '.?!':
            cleaned += '.'

        return cleaned.strip()

    def is_valid_input(self, text: str) -> bool:
        """Check if text is valid for processing (not just noise/filler)"""
        if not text:
            return False

        cleaned = self.lint(text)
        words = cleaned.split()

        # Must have at least 2 meaningful words
        if len(words) < 2:
            return False

        # Check if mostly filler
        meaningful_words = [w for w in words if w.lower() not in self.filler_words]
        if len(meaningful_words) < 2:
            return False

        return True


class SpeechTextBridge:
    """
    Bridge between audio transcription and agent harness.
    Handles the flow from speech -> text -> agent -> TTS response.
    """

    def __init__(
        self,
        harness: AgentHarness,
        text_linter: TextLinter,
        on_response: Optional[Callable[[HarnessResponse], None]] = None
    ):
        self.harness = harness
        self.linter = text_linter
        self.on_response = on_response
        self.logger = get_logger()

        # Processing state
        self._processing = False
        self._last_response_time = 0
        self._min_response_interval = 1.0  # Minimum seconds between responses

        # Register harness callbacks
        self.harness.add_response_callback(self._on_harness_response)
        self.harness.add_state_callback(self._on_harness_state)

    def process_transcription(self, text: str) -> Optional[HarnessResponse]:
        """
        Process transcribed speech text through the harness.

        Args:
            text: Raw transcribed text from speech recognition

        Returns:
            HarnessResponse if processed, None if rejected
        """
        # Check rate limiting
        current_time = time.time()
        if current_time - self._last_response_time < self._min_response_interval:
            self.logger.debug("Rate limited, skipping input", component="bridge")
            return None

        # Lint the text
        cleaned_text = self.linter.lint(text)

        # Validate
        if not self.linter.is_valid_input(text):
            self.logger.debug(f"Invalid input rejected: {text[:50]}", component="bridge")
            return None

        self.logger.info(f"Processing: {cleaned_text}", component="bridge")

        # Process through harness
        self._processing = True
        try:
            response = self.harness.process(cleaned_text)
            self._last_response_time = time.time()
            return response
        finally:
            self._processing = False

    def process_transcription_async(self, text: str):
        """Submit transcription for async processing"""
        cleaned_text = self.linter.lint(text)

        if not self.linter.is_valid_input(text):
            return

        self.harness.submit_request(cleaned_text, callback=self.on_response)

    def _on_harness_response(self, response: HarnessResponse):
        """Internal callback for harness responses"""
        self.logger.info(
            f"Response generated in {response.duration_ms:.0f}ms",
            component="bridge"
        )

        if self.on_response:
            self.on_response(response)

    def _on_harness_state(self, state: HarnessState):
        """Internal callback for harness state changes"""
        self.logger.debug(f"Harness state: {state.value}", component="bridge")

    @property
    def is_processing(self) -> bool:
        return self._processing


class IntegratedAudioProcessor:
    """
    Integrated audio processor that connects transcription to the harness.
    Runs the child processor with harness integration.
    """

    def __init__(
        self,
        audio_queue: MPQueue,
        audio_config: AudioConfig,
        bridge: SpeechTextBridge
    ):
        self.audio_queue = audio_queue
        self.config = audio_config
        self.bridge = bridge
        self.logger = logging.getLogger(__name__)
        self.running = False

        # Speech recognition
        import speech_recognition as sr
        from pydub import AudioSegment
        self.recognizer = sr.Recognizer()

    def process_audio_chunk(self, audio_data: bytes) -> Optional[str]:
        """Transcribe audio chunk to text"""
        import speech_recognition as sr
        from pydub import AudioSegment

        try:
            # Convert bytes to AudioData for speech recognition
            audio_segment = AudioSegment(
                data=audio_data,
                sample_width=2,  # 16-bit audio
                frame_rate=self.config.sample_rate,
                channels=self.config.channels
            )

            # Convert to wav format in memory
            wav_data = audio_segment.export(format="wav").read()

            # Create AudioData object
            audio_data_obj = sr.AudioData(wav_data, self.config.sample_rate, 2)

            # Perform speech recognition
            text = self.recognizer.recognize_google(audio_data_obj)
            return text

        except sr.UnknownValueError:
            self.logger.debug("Speech recognition could not understand audio")
            return None
        except sr.RequestError as e:
            self.logger.error(f"Speech recognition service error: {e}")
            return None
        except Exception as e:
            self.logger.error(f"Error processing audio chunk: {e}")
            return None

    def run(self):
        """Main processing loop"""
        self.running = True
        self.logger.info("IntegratedAudioProcessor started")

        while self.running:
            try:
                # Wait for audio data
                if not self.audio_queue.empty():
                    audio_data = self.audio_queue.get(timeout=1.0)

                    if audio_data is None:
                        break

                    # Transcribe
                    transcript = self.process_audio_chunk(audio_data)

                    if transcript:
                        self.logger.info(f"Transcribed: {transcript}")

                        # Process through bridge (which goes to harness)
                        response = self.bridge.process_transcription(transcript)

                        if response:
                            self.logger.info(
                                f"Response: {response.spoken_response[:100]}..."
                                if len(response.spoken_response) > 100
                                else f"Response: {response.spoken_response}"
                            )
                else:
                    time.sleep(0.1)

            except Empty:
                continue
            except Exception as e:
                self.logger.error(f"Error in IntegratedAudioProcessor: {e}")
                import traceback
                traceback.print_exc()
                time.sleep(1.0)

        self.logger.info("IntegratedAudioProcessor stopped")

    def stop(self):
        """Stop the processor"""
        self.running = False


class VoiceAgentSystem:
    """
    Main voice agent system that orchestrates all components.
    """

    def __init__(
        self,
        harness_config_path: str = None,
        audio_config_path: str = "config/audio_config.json",
        router_enabled: bool = True,
        tts_enabled: bool = True,
        default_tier: str = "standard"
    ):
        self.logger = self._setup_logging()

        # Load configurations
        self.audio_config = AudioConfig(audio_config_path)

        # Create harness
        self.harness = create_harness(
            config_path=harness_config_path,
            router_enabled=router_enabled,
            service_rep_enabled=tts_enabled,
            default_tier=default_tier
        )

        # Create text linter
        self.linter = TextLinter()

        # Create bridge
        self.bridge = SpeechTextBridge(
            harness=self.harness,
            text_linter=self.linter,
            on_response=self._on_response
        )

        # Audio components
        self.audio_queue = MPQueue()
        self.device_manager = AudioDeviceManager(self.audio_config)

        # Processing components
        self.audio_processor = None
        self.main_processor = None
        self.processor_thread = None
        self.main_processor_thread = None

        # State
        self.running = False

        self.logger.info("VoiceAgentSystem initialized")

    def _setup_logging(self) -> logging.Logger:
        """Setup logging for the system"""
        os.makedirs("logs", exist_ok=True)

        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler("logs/voice_agent.log"),
                logging.StreamHandler(sys.stdout)
            ]
        )

        return logging.getLogger(__name__)

    def _on_response(self, response: HarnessResponse):
        """Callback for harness responses"""
        # Log response
        self.logger.info(
            f"[RESPONSE] {response.spoken_response[:200]}"
            + ("..." if len(response.spoken_response) > 200 else "")
        )

        if response.classification:
            self.logger.info(
                f"[ROUTING] Tier: {response.classification.tier_name}, "
                f"Confidence: {response.classification.confidence:.2f}"
            )

        if response.agent_response and response.agent_response.tools_used:
            self.logger.info(f"[TOOLS] Used: {', '.join(response.agent_response.tools_used)}")

    def start(self):
        """Start the voice agent system"""
        self.logger.info("Starting VoiceAgentSystem...")
        self.running = True

        # Find audio device
        device_index = self.device_manager.wait_for_input_device()
        if device_index is None:
            self.logger.error("No audio input device found")
            return False

        self.logger.info(f"Using audio device index: {device_index}")

        # Start harness async processing
        self.harness.start_async_processing()

        # Create integrated audio processor
        self.audio_processor = IntegratedAudioProcessor(
            audio_queue=self.audio_queue,
            audio_config=self.audio_config,
            bridge=self.bridge
        )

        # Start processor in thread
        self.processor_thread = threading.Thread(
            target=self.audio_processor.run,
            daemon=True
        )
        self.processor_thread.start()

        # Create main audio processor
        self.main_processor = MainProcessor(self.audio_config, self.audio_queue)

        # Start main processor in thread
        self.main_processor_thread = threading.Thread(
            target=self.main_processor.run,
            args=(device_index,),
            daemon=True
        )
        self.main_processor_thread.start()

        self.logger.info("VoiceAgentSystem started successfully")
        self.logger.info("Speak to interact with the AI agent...")

        return True

    def run_blocking(self):
        """Run the system and block until stopped"""
        if not self.start():
            return

        try:
            while self.running:
                time.sleep(0.5)
        except KeyboardInterrupt:
            self.logger.info("Received interrupt signal")
        finally:
            self.stop()

    def stop(self):
        """Stop the voice agent system"""
        self.logger.info("Stopping VoiceAgentSystem...")
        self.running = False

        # Stop components
        if self.main_processor:
            self.main_processor.stop()

        if self.audio_processor:
            self.audio_processor.stop()
            self.audio_queue.put(None)  # Signal shutdown

        # Stop harness
        self.harness.stop_async_processing()
        self.harness.cleanup()

        # Wait for threads
        if self.processor_thread and self.processor_thread.is_alive():
            self.processor_thread.join(timeout=5.0)

        if self.main_processor_thread and self.main_processor_thread.is_alive():
            self.main_processor_thread.join(timeout=5.0)

        self.logger.info("VoiceAgentSystem stopped")


def interactive_mode(harness: AgentHarness):
    """Run in interactive text mode (for testing without audio)"""
    print("\n" + "="*60)
    print("Voice Agent System - Interactive Mode")
    print("="*60)
    print("Type your messages below. Type 'quit' or 'exit' to stop.")
    print("Commands: /router on|off, /tts on|off, /tier simple|standard|advanced")
    print("="*60 + "\n")

    linter = TextLinter()

    while True:
        try:
            user_input = input("\nYou: ").strip()

            if not user_input:
                continue

            if user_input.lower() in ['quit', 'exit', 'q']:
                print("Goodbye!")
                break

            # Handle commands
            if user_input.startswith('/'):
                parts = user_input.split()
                cmd = parts[0].lower()

                if cmd == '/router':
                    if len(parts) > 1:
                        if parts[1].lower() == 'on':
                            harness.enable_router()
                            print("Router enabled")
                        else:
                            harness.disable_router()
                            print("Router disabled")
                    continue

                elif cmd == '/tts':
                    if len(parts) > 1:
                        if parts[1].lower() == 'on':
                            harness.enable_service_rep()
                            print("TTS enabled")
                        else:
                            harness.disable_service_rep()
                            print("TTS disabled")
                    continue

                elif cmd == '/tier':
                    if len(parts) > 1:
                        harness.set_default_tier(parts[1])
                        print(f"Default tier set to: {parts[1]}")
                    continue

                elif cmd == '/tools':
                    tools = harness.list_tools()
                    print(f"Available tools: {', '.join(tools)}")
                    continue

                elif cmd == '/help':
                    print("Commands:")
                    print("  /router on|off - Enable/disable task routing")
                    print("  /tts on|off    - Enable/disable text-to-speech")
                    print("  /tier <name>   - Set default tier (simple/standard/advanced)")
                    print("  /tools         - List available tools")
                    print("  /help          - Show this help")
                    continue

            # Process input
            cleaned = linter.lint(user_input)

            print("\nAgent: ", end="", flush=True)

            # Process with streaming
            full_response = ""
            for chunk in harness.process_streaming(cleaned):
                print(chunk, end="", flush=True)
                full_response += chunk

            print("\n")

        except KeyboardInterrupt:
            print("\nGoodbye!")
            break
        except Exception as e:
            print(f"\nError: {e}")


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Voice-Activated AI Agent System",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py                    # Start with voice input
  python main.py --interactive      # Text-only interactive mode
  python main.py --list-devices     # List audio devices
  python main.py --no-router        # Disable task routing
  python main.py --tier advanced    # Use advanced tier by default
        """
    )

    parser.add_argument(
        "--config",
        default="config/harness_config.json",
        help="Path to harness configuration file"
    )
    parser.add_argument(
        "--audio-config",
        default="config/audio_config.json",
        help="Path to audio configuration file"
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="List available audio devices and exit"
    )
    parser.add_argument(
        "--interactive", "-i",
        action="store_true",
        help="Run in interactive text mode (no audio)"
    )
    parser.add_argument(
        "--no-router",
        action="store_true",
        help="Disable task routing"
    )
    parser.add_argument(
        "--no-tts",
        action="store_true",
        help="Disable text-to-speech output"
    )
    parser.add_argument(
        "--tier",
        choices=["simple", "standard", "advanced"],
        default="standard",
        help="Default agent tier"
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging"
    )

    args = parser.parse_args()

    # Setup logging level
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    # List devices and exit
    if args.list_devices:
        config = AudioConfig(args.audio_config)
        device_manager = AudioDeviceManager(config)
        devices = device_manager.list_devices()

        print("\nAvailable Audio Devices:")
        print("-" * 60)
        for device in devices:
            vad_rates = ', '.join(map(str, device['supported_vad_rates'])) or 'None'
            print(f"  [{device['index']}] {device['name']}")
            print(f"      Channels: {device['channels']}, Input: {device['is_input']}")
            print(f"      VAD Rates: {vad_rates}")
            print()
        return

    # Interactive mode
    if args.interactive:
        harness = create_harness(
            config_path=args.config if os.path.exists(args.config) else None,
            router_enabled=not args.no_router,
            service_rep_enabled=not args.no_tts,
            default_tier=args.tier
        )

        try:
            interactive_mode(harness)
        finally:
            harness.cleanup()
        return

    # Full voice mode
    system = VoiceAgentSystem(
        harness_config_path=args.config if os.path.exists(args.config) else None,
        audio_config_path=args.audio_config,
        router_enabled=not args.no_router,
        tts_enabled=not args.no_tts,
        default_tier=args.tier
    )

    # Handle signals
    def signal_handler(signum, frame):
        print("\nShutting down...")
        system.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Run
    system.run_blocking()


if __name__ == "__main__":
    main()
