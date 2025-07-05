#!/usr/bin/env python3
"""
AI Assistant Integration - Complete voice-to-voice AI assistant
"""

import os
import sys
import json
import logging
import signal
import time
from pathlib import Path
from typing import Dict, Any, Optional
import argparse

# Import our modules
from text_processor import TextProcessor, create_text_processor
from Qwen import QwenHandler, create_qwen_handler
from voice import VoiceStreamer, create_voice_streamer_from_dict
from audio import AudioAgent


class AIAssistant:
    """Main AI Assistant orchestrator"""
    
    def __init__(self, config_path: str = "config/text_processor_config.json"):
        self.config_path = config_path
        self.config = self._load_config()
        self.logger = self._setup_logging()
        
        # Initialize components
        self.llm_handler: Optional[QwenHandler] = None
        self.text_processor: Optional[TextProcessor] = None
        self.voice_streamer: Optional[VoiceStreamer] = None
        self.audio_agent: Optional[AudioAgent] = None
        
        # State
        self.running = False
        self.initialized = False
        
        # Setup signal handlers
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
    
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from file"""
        try:
            with open(self.config_path, 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            print(f"Configuration file not found: {self.config_path}")
            return self._default_config()
        except json.JSONDecodeError as e:
            print(f"Invalid JSON in configuration file: {e}")
            return self._default_config()
    
    def _default_config(self) -> Dict[str, Any]:
        """Default configuration"""
        return {
            "llm_handler": {
                "model": "qwen2.5-7b-instruct",
                "api_base": "http://localhost:8000",
                "temperature": 0.7,
                "max_tokens": 2048
            },
            "processing": {
                "stream_responses": True,
                "max_context_length": 10
            },
            "voice_output": {
                "engine": "pyttsx3",
                "rate": 180,
                "volume": 0.8,
                "streaming_enabled": True
            }
        }
    
    def _setup_logging(self) -> logging.Logger:
        """Setup logging configuration"""
        # Create logs directory
        os.makedirs("logs", exist_ok=True)
        
        # Configure logging
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler("logs/ai_assistant.log"),
                logging.StreamHandler(sys.stdout)
            ]
        )
        
        return logging.getLogger(__name__)
    
    def initialize(self) -> bool:
        """Initialize all components"""
        try:
            self.logger.info("Initializing AI Assistant...")
            
            # Initialize LLM handler
            self.logger.info("Initializing LLM handler...")
            self.llm_handler = create_qwen_handler(self.config["llm_handler"])
            
            if not self.llm_handler.validate_config():
                self.logger.error("LLM handler configuration validation failed")
                return False
            
            # Initialize text processor
            self.logger.info("Initializing text processor...")
            self.text_processor = create_text_processor(self.llm_handler, self.config)
            
            # Initialize voice streamer
            self.logger.info("Initializing voice streamer...")
            self.voice_streamer = create_voice_streamer_from_dict(self.config["voice_output"])
            
            # Set up integration callbacks
            self._setup_integration()
            
            self.initialized = True
            self.logger.info("AI Assistant initialized successfully")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to initialize AI Assistant: {e}")
            return False
    
    def _setup_integration(self):
        """Setup integration between components"""
        if not (self.text_processor and self.voice_streamer):
            return
        
        # Add voice callback to text processor
        def voice_callback(text: str):
            """Callback to send text to voice streamer"""
            if self.voice_streamer:
                self.voice_streamer.add_text_chunk(text)
        
        self.text_processor.add_response_callback(voice_callback)
        
        # Add speech callback to voice streamer
        def speech_callback(text: str):
            """Callback when speech is produced"""
            self.logger.debug(f"Speaking: {text[:50]}...")
        
        self.voice_streamer.add_speech_callback(speech_callback)
    
    def start(self):
        """Start the AI Assistant"""
        if not self.initialized:
            if not self.initialize():
                self.logger.error("Failed to initialize AI Assistant")
                return False
        
        try:
            self.running = True
            self.logger.info("Starting AI Assistant...")
            
            # Start text processor
            self.text_processor.start()
            
            # Start voice streamer
            self.voice_streamer.start_streaming()
            
            # Start audio processing (if configured)
            if self.config.get("enable_audio_input", True):
                self._start_audio_processing()
            
            self.logger.info("AI Assistant started successfully")
            
            # Main loop
            self._main_loop()
            
        except Exception as e:
            self.logger.error(f"Error starting AI Assistant: {e}")
            return False
        
        return True
    
    def _start_audio_processing(self):
        """Start audio processing for voice input"""
        try:
            # Initialize audio agent
            audio_config_path = "config/audio_config.json"
            if os.path.exists(audio_config_path):
                self.audio_agent = AudioAgent(audio_config_path)
                
                # Override the child processor to integrate with our text processor
                original_process_audio = self.audio_agent.child_process
                
                def integrated_processor():
                    """Integrated audio processor that sends to text processor"""
                    # This would need to be implemented to integrate with the audio.py module
                    pass
                
                # Note: This is a simplified integration point
                # In a real implementation, you'd need to modify the audio.py module
                # to call our text processor instead of just logging
                
            else:
                self.logger.warning("Audio configuration not found, skipping audio input")
                
        except Exception as e:
            self.logger.error(f"Failed to start audio processing: {e}")
    
    def _main_loop(self):
        """Main application loop"""
        self.logger.info("AI Assistant is running. Press Ctrl+C to exit.")
        
        # If no audio input, provide text input interface
        if not self.audio_agent:
            self._text_input_loop()
        else:
            # Audio processing loop
            try:
                self.audio_agent.run()
            except KeyboardInterrupt:
                pass
    
    def _text_input_loop(self):
        """Text input loop for testing without audio"""
        try:
            while self.running:
                try:
                    text = input("\nYou: ")
                    if text.lower() in ['quit', 'exit', 'bye']:
                        break
                    
                    if text.strip():
                        self.logger.info(f"Processing text input: {text}")
                        
                        # Process through text processor
                        request_id = self.text_processor.process_transcript(text)
                        
                        if request_id:
                            self.logger.info(f"Text processed with ID: {request_id}")
                        else:
                            self.logger.warning("Failed to process text")
                        
                        # Small delay to allow processing
                        time.sleep(0.5)
                        
                except EOFError:
                    break
                except Exception as e:
                    self.logger.error(f"Error in text input loop: {e}")
                    
        except KeyboardInterrupt:
            pass
    
    def stop(self):
        """Stop the AI Assistant"""
        self.logger.info("Stopping AI Assistant...")
        self.running = False
        
        # Stop components
        if self.text_processor:
            self.text_processor.stop()
        
        if self.voice_streamer:
            self.voice_streamer.stop_streaming()
            self.voice_streamer.cleanup()
        
        if self.audio_agent:
            self.audio_agent.stop()
        
        self.logger.info("AI Assistant stopped")
    
    def _signal_handler(self, signum, frame):
        """Handle system signals"""
        self.logger.info(f"Received signal {signum}, shutting down...")
        self.stop()
        sys.exit(0)
    
    def process_text(self, text: str) -> Optional[str]:
        """Process text input directly (for API usage)"""
        if not self.initialized:
            return None
        
        try:
            # Process through text processor
            request_id = self.text_processor.process_transcript(text)
            
            if request_id:
                # Wait for processing to complete
                # In a real implementation, this would need proper async handling
                time.sleep(1.0)
                return f"Processed: {request_id}"
            
            return None
            
        except Exception as e:
            self.logger.error(f"Error processing text: {e}")
            return None
    
    def get_status(self) -> Dict[str, Any]:
        """Get current status of the AI Assistant"""
        status = {
            "initialized": self.initialized,
            "running": self.running,
            "components": {}
        }
        
        if self.llm_handler:
            status["components"]["llm_handler"] = self.llm_handler.get_model_info()
        
        if self.text_processor:
            status["components"]["text_processor"] = self.text_processor.get_conversation_summary()
        
        if self.voice_streamer:
            status["components"]["voice_streamer"] = self.voice_streamer.get_voice_info()
        
        return status


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description="AI Assistant with Voice Interface")
    parser.add_argument("--config", default="config/text_processor_config.json", 
                       help="Path to configuration file")
    parser.add_argument("--text-only", action="store_true", 
                       help="Use text input only (no audio)")
    parser.add_argument("--status", action="store_true", 
                       help="Show status and exit")
    
    args = parser.parse_args()
    
    # Create AI Assistant
    assistant = AIAssistant(args.config)
    
    if args.status:
        # Show status
        if assistant.initialize():
            status = assistant.get_status()
            print(json.dumps(status, indent=2))
        else:
            print("Failed to initialize AI Assistant")
        return
    
    # Start assistant
    try:
        if args.text_only:
            # Disable audio input
            assistant.config["enable_audio_input"] = False
        
        assistant.start()
        
    except KeyboardInterrupt:
        print("\nShutting down...")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        assistant.stop()


if __name__ == "__main__":
    main()