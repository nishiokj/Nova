#!/usr/bin/env python3
"""
LLM Handler - Abstract base class for OpenAI-compatible LLM interfaces
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List, Iterator, Union
from dataclasses import dataclass
import logging
import json


@dataclass
class ChatMessage:
    """Represents a chat message with role and content"""
    role: str  # "system", "user", "assistant"
    content: str
    
    def to_dict(self) -> Dict[str, str]:
        """Convert to dictionary format"""
        return {"role": self.role, "content": self.content}


@dataclass
class LLMResponse:
    """Represents a complete LLM response"""
    content: str
    finish_reason: str
    usage: Optional[Dict[str, int]] = None
    model: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary format"""
        return {
            "content": self.content,
            "finish_reason": self.finish_reason,
            "usage": self.usage,
            "model": self.model
        }


@dataclass
class StreamChunk:
    """Represents a streaming chunk from LLM"""
    content: str
    finish_reason: Optional[str] = None
    is_complete: bool = False
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary format"""
        return {
            "content": self.content,
            "finish_reason": self.finish_reason,
            "is_complete": self.is_complete
        }


class LLMHandler(ABC):
    """Abstract base class for LLM handlers with OpenAI-compatible interface"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)
        self.model_name = config.get("model", "unknown")
        self.temperature = config.get("temperature", 0.7)
        self.max_tokens = config.get("max_tokens", 2048)
        self.system_prompt = config.get("system_prompt", "")
        
    @abstractmethod
    def _make_request(self, messages: List[ChatMessage], stream: bool = False) -> Union[LLMResponse, Iterator[StreamChunk]]:
        """Make request to LLM service - to be implemented by subclasses"""
        pass
    
    def send_message(self, message: str, context: Optional[List[ChatMessage]] = None) -> LLMResponse:
        """
        Send a message to the LLM and get a complete response
        
        Args:
            message: The user message to send
            context: Optional previous conversation context
            
        Returns:
            LLMResponse object with the complete response
        """
        try:
            messages = self._prepare_messages(message, context)
            response = self._make_request(messages, stream=False)
            
            if not isinstance(response, LLMResponse):
                raise ValueError("Expected LLMResponse from non-streaming request")
            
            self.logger.debug(f"Sent message to {self.model_name}: {message[:100]}...")
            self.logger.debug(f"Received response: {response.content[:100]}...")
            
            return response
            
        except Exception as e:
            self.logger.error(f"Error in send_message: {e}")
            return LLMResponse(
                content=f"Error: {str(e)}",
                finish_reason="error",
                model=self.model_name
            )
    
    def stream_message(self, message: str, context: Optional[List[ChatMessage]] = None) -> Iterator[StreamChunk]:
        """
        Send a message to the LLM and stream the response
        
        Args:
            message: The user message to send
            context: Optional previous conversation context
            
        Yields:
            StreamChunk objects with incremental response content
        """
        try:
            messages = self._prepare_messages(message, context)
            response_stream = self._make_request(messages, stream=True)
            
            if not hasattr(response_stream, '__iter__'):
                raise ValueError("Expected iterator from streaming request")
            
            self.logger.debug(f"Started streaming message to {self.model_name}: {message[:100]}...")
            
            for chunk in response_stream:
                if not isinstance(chunk, StreamChunk):
                    raise ValueError("Expected StreamChunk from streaming response")
                yield chunk
                
        except Exception as e:
            self.logger.error(f"Error in stream_message: {e}")
            yield StreamChunk(
                content=f"Error: {str(e)}",
                finish_reason="error",
                is_complete=True
            )
    
    def _prepare_messages(self, message: str, context: Optional[List[ChatMessage]] = None) -> List[ChatMessage]:
        """
        Prepare messages list with system prompt and context
        
        Args:
            message: The user message
            context: Optional conversation context
            
        Returns:
            List of ChatMessage objects ready for the LLM
        """
        messages = []
        
        # Add system prompt if configured
        if self.system_prompt:
            messages.append(ChatMessage(role="system", content=self.system_prompt))
        
        # Add conversation context if provided
        if context:
            messages.extend(context)
        
        # Add current user message
        messages.append(ChatMessage(role="user", content=message))
        
        return messages
    
    def _apply_template(self, template: str, **kwargs) -> str:
        """
        Apply template formatting to prompts
        
        Args:
            template: Template string with {placeholder} format
            **kwargs: Values to substitute in template
            
        Returns:
            Formatted string
        """
        try:
            return template.format(**kwargs)
        except KeyError as e:
            self.logger.warning(f"Missing template variable: {e}")
            return template
        except Exception as e:
            self.logger.error(f"Error applying template: {e}")
            return template
    
    def validate_config(self) -> bool:
        """
        Validate handler configuration
        
        Returns:
            True if configuration is valid, False otherwise
        """
        required_fields = ["model"]
        
        for field in required_fields:
            if field not in self.config:
                self.logger.error(f"Missing required configuration field: {field}")
                return False
        
        return True
    
    def get_model_info(self) -> Dict[str, Any]:
        """
        Get information about the current model
        
        Returns:
            Dictionary with model information
        """
        return {
            "model": self.model_name,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "system_prompt": self.system_prompt[:100] + "..." if len(self.system_prompt) > 100 else self.system_prompt
        }
    
    def reset_conversation(self):
        """Reset any conversation state - can be overridden by subclasses"""
        pass