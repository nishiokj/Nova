import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

_LOGGER = logging.getLogger(__name__)


def _clean_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """Remove metadata keys (like '_comment') before dataclass initialization."""
    return {k: v for k, v in data.items() if not k.startswith('_')}


@dataclass
class VoiceOutputConfig:
    """Voice output parameters consumed by the TTS worker."""
    engine: str = "pyttsx3"
    voice_id: Optional[str] = None
    rate: int = 180
    volume: float = 0.8
    pitch: int = 0
    output_device: Optional[str] = None
    streaming_enabled: bool = True
    sentence_delay: float = 0.0
    word_delay: float = 0.0

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "VoiceOutputConfig":
        return cls(**_clean_dict(data))

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ProcessingConfig:
    """Configuration that controls the speech/text pipeline behavior."""
    max_context_length: int = 10
    processing_timeout: int = 30
    stream_responses: bool = True
    enable_conversation_history: bool = True
    log_interactions: bool = True
    tts_holdoff_seconds: float = 0.35
    min_response_interval: float = 0.5
    tts_feedback_window: float = 8.0

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ProcessingConfig":
        return cls(**_clean_dict(data))


@dataclass
class TextProcessorConfig:
    """Aggregated configuration coming from config/text_processor_config.json."""
    llm_handler: Dict[str, Any] = field(default_factory=dict)
    intent_classification: Dict[str, Any] = field(default_factory=dict)
    response_templates: Dict[str, Any] = field(default_factory=dict)
    processing: ProcessingConfig = field(default_factory=ProcessingConfig)
    voice_output: VoiceOutputConfig = field(default_factory=VoiceOutputConfig)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TextProcessorConfig":
        return cls(
            llm_handler=data.get("llm_handler", {}),
            intent_classification=data.get("intent_classification", {}),
            response_templates=data.get("response_templates", {}),
            processing=ProcessingConfig.from_dict(data.get("processing", {})),
            voice_output=VoiceOutputConfig.from_dict(data.get("voice_output", {}))
        )

    @classmethod
    def load(cls, path: str = "config/text_processor_config.json") -> "TextProcessorConfig":
        config_path = Path(path)
        if not config_path.exists():
            _LOGGER.warning("Text processor config not found (%s), using defaults", path)
            return cls()
        try:
            with config_path.open("r") as f:
                data = json.load(f)
        except json.JSONDecodeError as exc:
            _LOGGER.error("Invalid JSON in %s: %s", path, exc)
            return cls()
        except Exception as exc:  # pragma: no cover - unexpected I/O
            _LOGGER.error("Unable to read text processor config (%s): %s", path, exc)
            return cls()
        return cls.from_dict(data)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "llm_handler": self.llm_handler,
            "intent_classification": self.intent_classification,
            "response_templates": self.response_templates,
            "processing": asdict(self.processing),
            "voice_output": self.voice_output.to_dict()
        }
