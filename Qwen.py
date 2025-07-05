#!/usr/bin/env python3
"""
Qwen LLM Handler - Implementation for Qwen models using OpenAI-compatible API
"""

import json
import requests
import time
from typing import Dict, Any, List, Iterator, Union, Optional
from urllib.parse import urljoin

from llm_handler import LLMHandler, ChatMessage, LLMResponse, StreamChunk


class QwenHandler(LLMHandler):
    """Qwen LLM handler implementing OpenAI-compatible interface"""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        
        # Qwen-specific configuration
        self.api_base = config.get("api_base", "http://localhost:8000")
        self.api_key = config.get("api_key", "")
        self.timeout = config.get("timeout", 30)
        self.max_retries = config.get("max_retries", 3)
        self.retry_delay = config.get("retry_delay", 1)
        
        # OpenAI-compatible endpoints
        self.chat_endpoint = urljoin(self.api_base, "/v1/chat/completions")
        
        # Request headers
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        
        if self.api_key:
            self.headers["Authorization"] = f"Bearer {self.api_key}"
        
        # Validate configuration
        if not self.validate_config():
            raise ValueError("Invalid Qwen configuration")
    
    def _make_request(self, messages: List[ChatMessage], stream: bool = False) -> Union[LLMResponse, Iterator[StreamChunk]]:
        """
        Make request to Qwen API
        
        Args:
            messages: List of chat messages
            stream: Whether to stream the response
            
        Returns:
            LLMResponse for non-streaming or Iterator[StreamChunk] for streaming
        """
        # Prepare request payload
        payload = {
            "model": self.model_name,
            "messages": [msg.to_dict() for msg in messages],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": stream
        }
        
        # Add additional parameters if configured
        if "top_p" in self.config:
            payload["top_p"] = self.config["top_p"]
        if "frequency_penalty" in self.config:
            payload["frequency_penalty"] = self.config["frequency_penalty"]
        if "presence_penalty" in self.config:
            payload["presence_penalty"] = self.config["presence_penalty"]
        
        if stream:
            return self._make_streaming_request(payload)
        else:
            return self._make_non_streaming_request(payload)
    
    def _make_non_streaming_request(self, payload: Dict[str, Any]) -> LLMResponse:
        """Make non-streaming request to Qwen API"""
        for attempt in range(self.max_retries):
            try:
                self.logger.debug(f"Making non-streaming request to Qwen API (attempt {attempt + 1})")
                
                response = requests.post(
                    self.chat_endpoint,
                    headers=self.headers,
                    json=payload,
                    timeout=self.timeout
                )
                
                if response.status_code == 200:
                    data = response.json()
                    return self._parse_response(data)
                
                elif response.status_code == 429:
                    # Rate limit - wait and retry
                    wait_time = self.retry_delay * (2 ** attempt)
                    self.logger.warning(f"Rate limited, waiting {wait_time}s before retry")
                    time.sleep(wait_time)
                    continue
                
                else:
                    error_msg = f"API request failed with status {response.status_code}: {response.text}"
                    self.logger.error(error_msg)
                    
                    if attempt == self.max_retries - 1:
                        return LLMResponse(
                            content=f"Error: {error_msg}",
                            finish_reason="error",
                            model=self.model_name
                        )
                    
                    time.sleep(self.retry_delay)
                    
            except requests.exceptions.Timeout:
                self.logger.warning(f"Request timeout (attempt {attempt + 1})")
                if attempt == self.max_retries - 1:
                    return LLMResponse(
                        content="Error: Request timeout",
                        finish_reason="error",
                        model=self.model_name
                    )
                time.sleep(self.retry_delay)
                
            except requests.exceptions.ConnectionError:
                self.logger.warning(f"Connection error (attempt {attempt + 1})")
                if attempt == self.max_retries - 1:
                    return LLMResponse(
                        content="Error: Connection failed",
                        finish_reason="error",
                        model=self.model_name
                    )
                time.sleep(self.retry_delay)
                
            except Exception as e:
                self.logger.error(f"Unexpected error in API request: {e}")
                return LLMResponse(
                    content=f"Error: {str(e)}",
                    finish_reason="error",
                    model=self.model_name
                )
        
        return LLMResponse(
            content="Error: Max retries exceeded",
            finish_reason="error",
            model=self.model_name
        )
    
    def _make_streaming_request(self, payload: Dict[str, Any]) -> Iterator[StreamChunk]:
        """Make streaming request to Qwen API"""
        for attempt in range(self.max_retries):
            try:
                self.logger.debug(f"Making streaming request to Qwen API (attempt {attempt + 1})")
                
                response = requests.post(
                    self.chat_endpoint,
                    headers=self.headers,
                    json=payload,
                    timeout=self.timeout,
                    stream=True
                )
                
                if response.status_code == 200:
                    yield from self._parse_streaming_response(response)
                    return
                
                elif response.status_code == 429:
                    # Rate limit - wait and retry
                    wait_time = self.retry_delay * (2 ** attempt)
                    self.logger.warning(f"Rate limited, waiting {wait_time}s before retry")
                    time.sleep(wait_time)
                    continue
                
                else:
                    error_msg = f"API request failed with status {response.status_code}: {response.text}"
                    self.logger.error(error_msg)
                    
                    if attempt == self.max_retries - 1:
                        yield StreamChunk(
                            content=f"Error: {error_msg}",
                            finish_reason="error",
                            is_complete=True
                        )
                        return
                    
                    time.sleep(self.retry_delay)
                    
            except requests.exceptions.Timeout:
                self.logger.warning(f"Request timeout (attempt {attempt + 1})")
                if attempt == self.max_retries - 1:
                    yield StreamChunk(
                        content="Error: Request timeout",
                        finish_reason="error",
                        is_complete=True
                    )
                    return
                time.sleep(self.retry_delay)
                
            except requests.exceptions.ConnectionError:
                self.logger.warning(f"Connection error (attempt {attempt + 1})")
                if attempt == self.max_retries - 1:
                    yield StreamChunk(
                        content="Error: Connection failed",
                        finish_reason="error",
                        is_complete=True
                    )
                    return
                time.sleep(self.retry_delay)
                
            except Exception as e:
                self.logger.error(f"Unexpected error in streaming request: {e}")
                yield StreamChunk(
                    content=f"Error: {str(e)}",
                    finish_reason="error",
                    is_complete=True
                )
                return
        
        yield StreamChunk(
            content="Error: Max retries exceeded",
            finish_reason="error",
            is_complete=True
        )
    
    def _parse_response(self, data: Dict[str, Any]) -> LLMResponse:
        """Parse non-streaming response from Qwen API"""
        try:
            choices = data.get("choices", [])
            if not choices:
                return LLMResponse(
                    content="Error: No choices in response",
                    finish_reason="error",
                    model=self.model_name
                )
            
            choice = choices[0]
            message = choice.get("message", {})
            content = message.get("content", "")
            finish_reason = choice.get("finish_reason", "unknown")
            
            usage = data.get("usage", {})
            model = data.get("model", self.model_name)
            
            return LLMResponse(
                content=content,
                finish_reason=finish_reason,
                usage=usage,
                model=model
            )
            
        except Exception as e:
            self.logger.error(f"Error parsing response: {e}")
            return LLMResponse(
                content=f"Error parsing response: {str(e)}",
                finish_reason="error",
                model=self.model_name
            )
    
    def _parse_streaming_response(self, response: requests.Response) -> Iterator[StreamChunk]:
        """Parse streaming response from Qwen API"""
        try:
            for line in response.iter_lines():
                if not line:
                    continue
                
                line = line.decode('utf-8')
                
                # OpenAI streaming format uses "data: " prefix
                if line.startswith("data: "):
                    data_str = line[6:]  # Remove "data: " prefix
                    
                    # Check for end of stream
                    if data_str.strip() == "[DONE]":
                        yield StreamChunk(
                            content="",
                            finish_reason="stop",
                            is_complete=True
                        )
                        return
                    
                    try:
                        data = json.loads(data_str)
                        chunk = self._parse_stream_chunk(data)
                        if chunk:
                            yield chunk
                    except json.JSONDecodeError:
                        # Skip invalid JSON lines
                        continue
                        
        except Exception as e:
            self.logger.error(f"Error parsing streaming response: {e}")
            yield StreamChunk(
                content=f"Error: {str(e)}",
                finish_reason="error",
                is_complete=True
            )
    
    def _parse_stream_chunk(self, data: Dict[str, Any]) -> Optional[StreamChunk]:
        """Parse individual chunk from streaming response"""
        try:
            choices = data.get("choices", [])
            if not choices:
                return None
            
            choice = choices[0]
            delta = choice.get("delta", {})
            content = delta.get("content", "")
            finish_reason = choice.get("finish_reason")
            
            return StreamChunk(
                content=content,
                finish_reason=finish_reason,
                is_complete=finish_reason is not None
            )
            
        except Exception as e:
            self.logger.error(f"Error parsing stream chunk: {e}")
            return None
    
    def validate_config(self) -> bool:
        """Validate Qwen-specific configuration"""
        if not super().validate_config():
            return False
        
        # Check API base URL
        if not self.api_base:
            self.logger.error("Missing api_base configuration")
            return False
        
        # Test connection to API
        try:
            test_url = urljoin(self.api_base, "/v1/models")
            response = requests.get(test_url, headers=self.headers, timeout=5)
            if response.status_code not in [200, 404]:  # 404 is OK if models endpoint not available
                self.logger.warning(f"API connection test returned status {response.status_code}")
        except Exception as e:
            self.logger.warning(f"Could not test API connection: {e}")
        
        return True
    
    def get_model_info(self) -> Dict[str, Any]:
        """Get Qwen model information"""
        info = super().get_model_info()
        info.update({
            "api_base": self.api_base,
            "timeout": self.timeout,
            "max_retries": self.max_retries,
            "handler_type": "Qwen"
        })
        return info


# Factory function for easy instantiation
def create_qwen_handler(config: Dict[str, Any]) -> QwenHandler:
    """
    Factory function to create QwenHandler instance
    
    Args:
        config: Configuration dictionary
        
    Returns:
        QwenHandler instance
    """
    return QwenHandler(config)