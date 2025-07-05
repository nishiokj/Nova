#!/usr/bin/env python3
"""
Text Processor - Decision-making module for processing speech transcripts
"""

import json
import logging
import re
from typing import Dict, Any, List, Optional, Callable, Iterator
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
import threading
from queue import Queue, Empty

from llm_handler import LLMHandler, ChatMessage, LLMResponse, StreamChunk


class ProcessingIntent(Enum):
    """Enumeration of processing intents"""
    QUESTION = "question"
    COMMAND = "command"
    CONVERSATION = "conversation"
    TASK = "task"
    IGNORE = "ignore"
    UNCLEAR = "unclear"


@dataclass
class ProcessingContext:
    """Context for text processing operations"""
    transcript: str
    timestamp: datetime
    intent: Optional[ProcessingIntent] = None
    confidence: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)
    conversation_history: List[ChatMessage] = field(default_factory=list)


@dataclass
class ProcessingResult:
    """Result of text processing"""
    response: str
    intent: ProcessingIntent
    confidence: float
    should_respond: bool = True
    metadata: Dict[str, Any] = field(default_factory=dict)


class IntentClassifier:
    """Classifies user intents from speech transcripts"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)
        
        # Intent patterns - can be customized via config
        self.intent_patterns = config.get("intent_patterns", self._default_intent_patterns())
        
        # Confidence thresholds
        self.min_confidence = config.get("min_confidence", 0.5)
        self.high_confidence = config.get("high_confidence", 0.8)
    
    def _default_intent_patterns(self) -> Dict[ProcessingIntent, List[str]]:
        """Default intent classification patterns"""
        return {
            ProcessingIntent.QUESTION: [
                r'\b(what|how|why|when|where|who|which|can you|could you|would you|do you know)\b',
                r'\?',
                r'\b(explain|tell me|help me understand)\b'
            ],
            ProcessingIntent.COMMAND: [
                r'\b(please|can you|could you|would you|help me|assist me)\b.*\b(do|perform|execute|run|start|stop|create|make|generate)\b',
                r'\b(turn on|turn off|enable|disable|activate|deactivate)\b',
                r'\b(play|pause|stop|resume|skip|next|previous)\b'
            ],
            ProcessingIntent.TASK: [
                r'\b(I need to|I want to|I have to|let me|help me)\b.*\b(complete|finish|solve|fix|work on)\b',
                r'\b(schedule|plan|organize|manage|track)\b',
                r'\b(remind me|set reminder|create task|add to list)\b'
            ],
            ProcessingIntent.IGNORE: [
                r'\b(um|uh|ah|hmm|er|well)\b$',
                r'^[.,!?;:]*$',
                r'\b(test|testing|hello|hi)\b$'
            ]
        }
    
    def classify_intent(self, transcript: str) -> tuple[ProcessingIntent, float]:
        """
        Classify intent from transcript
        
        Args:
            transcript: The speech transcript to classify
            
        Returns:
            Tuple of (intent, confidence_score)
        """
        transcript_lower = transcript.lower().strip()
        
        if not transcript_lower:
            return ProcessingIntent.IGNORE, 1.0
        
        # Check each intent pattern
        intent_scores = {}
        
        for intent, patterns in self.intent_patterns.items():
            score = 0.0
            matches = 0
            
            for pattern in patterns:
                if re.search(pattern, transcript_lower):
                    matches += 1
                    score += 1.0
            
            if matches > 0:
                # Normalize score by number of patterns
                intent_scores[intent] = score / len(patterns)
        
        # Find highest scoring intent
        if intent_scores:
            best_intent = max(intent_scores, key=intent_scores.get)
            confidence = intent_scores[best_intent]
            
            # Apply confidence thresholds
            if confidence < self.min_confidence:
                return ProcessingIntent.UNCLEAR, confidence
            
            return best_intent, confidence
        
        # Default to conversation if no clear intent
        return ProcessingIntent.CONVERSATION, 0.3


class ResponseTemplate:
    """Template system for generating responses"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)
        
        # Load templates from config
        self.templates = config.get("response_templates", self._default_templates())
    
    def _default_templates(self) -> Dict[str, Dict[str, str]]:
        """Default response templates"""
        return {
            "system_prompts": {
                "question": "You are a helpful assistant. Answer the user's question clearly and concisely. Question: {transcript}",
                "command": "You are a helpful assistant. The user has given you a command. Respond appropriately to: {transcript}",
                "conversation": "You are a friendly conversational assistant. Respond naturally to: {transcript}",
                "task": "You are a task-oriented assistant. Help the user with their task: {transcript}",
                "unclear": "The user's intent is unclear. Ask for clarification about: {transcript}"
            },
            "fallback_responses": {
                "error": "I apologize, but I encountered an error processing your request.",
                "unclear": "I'm not sure I understand. Could you please clarify what you'd like me to help you with?",
                "timeout": "I'm sorry, but I'm taking too long to respond. Please try again."
            }
        }
    
    def get_system_prompt(self, intent: ProcessingIntent, context: ProcessingContext) -> str:
        """Get system prompt for given intent and context"""
        intent_key = intent.value
        template = self.templates["system_prompts"].get(intent_key, self.templates["system_prompts"]["conversation"])
        
        return template.format(
            transcript=context.transcript,
            timestamp=context.timestamp.isoformat(),
            **context.metadata
        )
    
    def get_fallback_response(self, error_type: str) -> str:
        """Get fallback response for errors"""
        return self.templates["fallback_responses"].get(error_type, "I apologize, but I'm having trouble right now.")


class TextProcessor:
    """Main text processing engine"""
    
    def __init__(self, llm_handler: LLMHandler, config: Dict[str, Any]):
        self.llm_handler = llm_handler
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)
        
        # Initialize components
        self.intent_classifier = IntentClassifier(config.get("intent_classification", {}))
        self.response_template = ResponseTemplate(config.get("response_templates", {}))
        
        # Processing configuration
        self.max_context_length = config.get("max_context_length", 10)
        self.processing_timeout = config.get("processing_timeout", 30)
        self.stream_responses = config.get("stream_responses", True)
        
        # Conversation state
        self.conversation_history: List[ChatMessage] = []
        self.processing_queue = Queue()
        self.response_callbacks: List[Callable] = []
        
        # Threading for async processing
        self.processing_thread = None
        self.running = False
    
    def start(self):
        """Start the text processor"""
        if self.running:
            return
        
        self.running = True
        self.processing_thread = threading.Thread(target=self._processing_loop, daemon=True)
        self.processing_thread.start()
        self.logger.info("Text processor started")
    
    def stop(self):
        """Stop the text processor"""
        self.running = False
        if self.processing_thread:
            self.processing_thread.join(timeout=5)
        self.logger.info("Text processor stopped")
    
    def process_transcript(self, transcript: str, callback: Optional[Callable] = None) -> Optional[str]:
        """
        Process a speech transcript
        
        Args:
            transcript: The speech transcript to process
            callback: Optional callback for streaming responses
            
        Returns:
            Response ID for tracking, or None if processing fails
        """
        try:
            # Create processing context
            context = ProcessingContext(
                transcript=transcript,
                timestamp=datetime.now(),
                conversation_history=self.conversation_history.copy()
            )
            
            # Classify intent
            intent, confidence = self.intent_classifier.classify_intent(transcript)
            context.intent = intent
            context.confidence = confidence
            
            self.logger.info(f"Processing transcript: '{transcript[:50]}...' (intent: {intent.value}, confidence: {confidence:.2f})")
            
            # Check if we should ignore this transcript
            if intent == ProcessingIntent.IGNORE and confidence > 0.7:
                self.logger.debug("Ignoring transcript due to high ignore confidence")
                return None
            
            # Queue for processing
            request_id = f"req_{datetime.now().timestamp()}"
            self.processing_queue.put((request_id, context, callback))
            
            return request_id
            
        except Exception as e:
            self.logger.error(f"Error processing transcript: {e}")
            return None
    
    def _processing_loop(self):
        """Main processing loop running in separate thread"""
        while self.running:
            try:
                # Get next processing request
                request_id, context, callback = self.processing_queue.get(timeout=1.0)
                
                # Process the request
                result = self._process_context(context)
                
                # Handle response
                if result and result.should_respond:
                    self._handle_response(result, callback)
                
                # Update conversation history
                self._update_conversation_history(context.transcript, result.response if result else "")
                
            except Empty:
                continue
            except Exception as e:
                self.logger.error(f"Error in processing loop: {e}")
    
    def _process_context(self, context: ProcessingContext) -> Optional[ProcessingResult]:
        """Process a single context"""
        try:
            # Get system prompt based on intent
            system_prompt = self.response_template.get_system_prompt(context.intent, context)
            
            # Update LLM handler system prompt
            original_prompt = self.llm_handler.system_prompt
            self.llm_handler.system_prompt = system_prompt
            
            try:
                if self.stream_responses:
                    # Stream response
                    response_chunks = []
                    
                    for chunk in self.llm_handler.stream_message(context.transcript, context.conversation_history):
                        response_chunks.append(chunk.content)
                        
                        # Yield chunk for real-time processing
                        if hasattr(self, '_current_callback') and self._current_callback:
                            self._current_callback(chunk.content)
                        
                        if chunk.is_complete:
                            break
                    
                    response = ''.join(response_chunks)
                else:
                    # Non-streaming response
                    llm_response = self.llm_handler.send_message(context.transcript, context.conversation_history)
                    response = llm_response.content
                
                return ProcessingResult(
                    response=response,
                    intent=context.intent,
                    confidence=context.confidence,
                    should_respond=True
                )
                
            finally:
                # Restore original system prompt
                self.llm_handler.system_prompt = original_prompt
                
        except Exception as e:
            self.logger.error(f"Error processing context: {e}")
            return ProcessingResult(
                response=self.response_template.get_fallback_response("error"),
                intent=context.intent or ProcessingIntent.UNCLEAR,
                confidence=0.0,
                should_respond=True
            )
    
    def _handle_response(self, result: ProcessingResult, callback: Optional[Callable]):
        """Handle processing result"""
        if callback:
            try:
                callback(result.response)
            except Exception as e:
                self.logger.error(f"Error in response callback: {e}")
        
        # Log the response
        self.logger.info(f"Generated response: {result.response[:100]}...")
    
    def _update_conversation_history(self, user_message: str, assistant_response: str):
        """Update conversation history"""
        # Add user message
        self.conversation_history.append(ChatMessage(role="user", content=user_message))
        
        # Add assistant response
        if assistant_response:
            self.conversation_history.append(ChatMessage(role="assistant", content=assistant_response))
        
        # Trim history if too long
        while len(self.conversation_history) > self.max_context_length * 2:  # *2 for user+assistant pairs
            self.conversation_history.pop(0)
    
    def add_response_callback(self, callback: Callable):
        """Add a callback for responses"""
        self.response_callbacks.append(callback)
    
    def remove_response_callback(self, callback: Callable):
        """Remove a response callback"""
        if callback in self.response_callbacks:
            self.response_callbacks.remove(callback)
    
    def clear_conversation_history(self):
        """Clear conversation history"""
        self.conversation_history.clear()
        self.logger.info("Conversation history cleared")
    
    def get_conversation_summary(self) -> Dict[str, Any]:
        """Get summary of current conversation"""
        return {
            "message_count": len(self.conversation_history),
            "latest_messages": [msg.to_dict() for msg in self.conversation_history[-4:]] if self.conversation_history else [],
            "processor_info": {
                "llm_model": self.llm_handler.get_model_info(),
                "stream_responses": self.stream_responses,
                "max_context_length": self.max_context_length
            }
        }


# Factory function for easy instantiation
def create_text_processor(llm_handler: LLMHandler, config: Dict[str, Any]) -> TextProcessor:
    """
    Factory function to create TextProcessor instance
    
    Args:
        llm_handler: LLM handler instance
        config: Configuration dictionary
        
    Returns:
        TextProcessor instance
    """
    return TextProcessor(llm_handler, config)